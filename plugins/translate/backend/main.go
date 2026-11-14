package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/abadojack/whatlanggo"
	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
)

var languages = []option{{"zh-CN", "简体中文"}, {"zh-TW", "繁體中文"}, {"en", "英语"}, {"ja", "日语"}, {"ko", "韩语"}, {"fr", "法语"}, {"de", "德语"}, {"es", "西班牙语"}, {"ru", "俄语"}, {"pt", "葡萄牙语"}, {"it", "意大利语"}}
var engines = []option{{"google", "Google（免费网页接口）"}, {"mymemory", "MyMemory"}, {"llm", "LLM"}}

type option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}
type request struct {
	Text   string `json:"text"`
	Source string `json:"source"`
	Target string `json:"target"`
	Engine string `json:"engine"`
}
type translation struct {
	Text   string `json:"text"`
	Source string `json:"source"`
	Target string `json:"target"`
}
type job struct {
	Done    bool         `json:"done"`
	Result  *translation `json:"result,omitempty"`
	Error   string       `json:"error,omitempty"`
	cancel  context.CancelFunc
	expires time.Time
}
type translator struct {
	mu             sync.Mutex
	jobs           map[string]*job
	target, engine string
	client         *http.Client
}

func valid(value string, options []option) bool {
	for _, o := range options {
		if o.Value == value {
			return true
		}
	}
	return false
}
func base(s string) string { return strings.Split(strings.ToLower(s), "-")[0] }
func detect(text string) string {
	// A single unaccented Latin word has too little context for statistical
	// detection. Prefer English for this common lookup case; an explicit source
	// language still takes precedence in translate.
	word := strings.TrimFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) })
	letters := 0
	englishWord := true
	for _, r := range word {
		switch {
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z':
			letters++
		case r == '-' || r == '\'' || r == '’':
		default:
			englishWord = false
		}
	}
	if englishWord && letters > 0 {
		return "en"
	}
	code := whatlanggo.Detect(text).Lang.Iso6391()
	if code == "zh" {
		return "zh-CN"
	}
	return code
}
func (t *translator) initialize(p protocol.InitializeParams) error {
	t.target, t.engine = "zh-CN", "mymemory"
	if v := p.Settings["target-language"]; len(v) == 1 {
		for _, language := range languages {
			if strings.EqualFold(v[0], language.Value) {
				t.target = language.Value
				break
			}
		}
	}
	if v := p.Settings["default-engine"]; len(v) == 1 && valid(v[0], engines) {
		t.engine = v[0]
	}
	t.jobs = map[string]*job{}
	return nil
}
func result(v any) (protocol.CommandResult, error) {
	b, e := json.Marshal(v)
	return protocol.CommandResult{Text: string(b)}, e
}
func failure(message string) (protocol.CommandResult, error) {
	return result(map[string]string{"error": message})
}
func (t *translator) command(_ context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for id, j := range t.jobs {
		if now.After(j.expires) {
			j.cancel()
			delete(t.jobs, id)
		}
	}
	switch p.CommandID {
	case "prepare-llm":
		var r request
		if json.Unmarshal([]byte(p.Input), &r) != nil {
			return failure("翻译参数无效")
		}
		value, err := prepareLLM(r, t.target)
		if err != nil {
			return failure(err.Error())
		}
		return result(value)
	case "config":
		return result(map[string]any{"target": t.target, "engine": t.engine, "languages": languages, "engines": engines})
	case "poll":
		if j := t.jobs[p.Input]; j != nil {
			return result(j)
		}
		return failure("翻译任务已失效，请重试")
	case "cancel":
		if j := t.jobs[p.Input]; j != nil {
			j.cancel()
			delete(t.jobs, p.Input)
		}
		return result(nil)
	case "translate":
		var r request
		if json.Unmarshal([]byte(p.Input), &r) != nil {
			return failure("翻译参数无效")
		}
		if r.Engine == "llm" {
			return failure("LLM 请求须通过宿主能力提交")
		}
		if strings.TrimSpace(r.Text) == "" || !utf8.ValidString(r.Text) || strings.ContainsRune(r.Text, 0) || utf8.RuneCountInString(r.Text) > 5000 {
			return failure("请输入 1～5000 字的文本")
		}
		if r.Source != "auto" && !valid(r.Source, languages) {
			return failure("请选择有效的原文语言")
		}
		if r.Target != "smart" && !valid(r.Target, languages) {
			return failure("请选择有效的目标语言")
		}
		if !valid(r.Engine, engines) {
			return failure("请选择有效的翻译引擎")
		}
		if r.Engine == "mymemory" && len(r.Text) > 500 {
			return failure("MyMemory 单次最多 500 UTF-8 字节，请缩短文本或切换 Google")
		}
		if len(t.jobs) >= 4 {
			return failure("翻译任务过多，请稍后重试")
		}
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return failure("无法创建翻译任务")
		}
		id := hex.EncodeToString(token)
		timeout := 12 * time.Second
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		j := &job{cancel: cancel, expires: now.Add(timeout + 18*time.Second)}
		t.jobs[id] = j
		target := t.target
		go func() {
			defer cancel()
			v, err := t.translate(ctx, r, target)
			t.mu.Lock()
			defer t.mu.Unlock()
			if t.jobs[id] != j {
				return
			}
			j.Done = true
			if err != nil {
				j.Error = err.Error()
			} else {
				j.Result = &v
			}
		}()
		return result(map[string]string{"id": id})
	}
	return failure("未知命令")
}
func (t *translator) get(ctx context.Context, endpoint string, params url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+params.Encode(), nil)
	if err != nil {
		return errors.New("无法创建翻译请求")
	}
	res, err := t.client.Do(req)
	if err != nil {
		return errors.New("翻译连接失败或超时，请检查网络或切换引擎")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("翻译服务返回 HTTP %d，请稍后重试或切换引擎", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, (256<<10)+1))
	if err != nil || len(data) > 256<<10 || json.Unmarshal(data, out) != nil {
		return errors.New("翻译服务响应无效，请切换引擎")
	}
	return nil
}
func (t *translator) translate(ctx context.Context, r request, preferred string) (translation, error) {
	target := r.Target
	if target == "smart" {
		target = preferred
	}
	if r.Engine == "google" {
		v, err := t.google(ctx, r.Text, r.Source, target)
		if err != nil {
			return v, err
		}
		if r.Target == "smart" && base(v.Source) == base(preferred) && target != "en" {
			return t.google(ctx, r.Text, v.Source, "en")
		}
		return v, nil
	}
	source := r.Source
	if source == "auto" {
		source = detect(r.Text)
	}
	if !valid(source, languages) {
		return translation{}, errors.New("无法识别原文语言，请手动选择")
	}
	if r.Target == "smart" && base(source) == base(preferred) {
		target = "en"
	}
	if source == target {
		return translation{r.Text, source, target}, nil
	}
	var response struct {
		Data struct {
			Text string `json:"translatedText"`
		} `json:"responseData"`
		Status int  `json:"responseStatus"`
		Quota  bool `json:"quotaFinished"`
	}
	err := t.get(ctx, "https://api.mymemory.translated.net/get", url.Values{"q": {r.Text}, "langpair": {source + "|" + target}}, &response)
	if err != nil {
		return translation{}, err
	}
	if response.Quota || response.Status != 200 {
		return translation{}, errors.New("MyMemory 额度已用完或不支持该语言组合，请切换引擎")
	}
	if strings.TrimSpace(response.Data.Text) == "" {
		return translation{}, errors.New("翻译服务未返回译文")
	}
	return translation{html.UnescapeString(response.Data.Text), source, target}, nil
}
func (t *translator) google(ctx context.Context, text, source, target string) (translation, error) {
	var response []json.RawMessage
	err := t.get(ctx, "https://translate.googleapis.com/translate_a/single", url.Values{"client": {"gtx"}, "sl": {source}, "tl": {target}, "dt": {"t"}, "q": {text}}, &response)
	if err != nil {
		return translation{}, err
	}
	if len(response) < 3 {
		return translation{}, errors.New("Google 翻译响应格式已变化，请切换引擎")
	}
	var rows [][]json.RawMessage
	var detected string
	if json.Unmarshal(response[0], &rows) != nil || json.Unmarshal(response[2], &detected) != nil || detected == "" {
		return translation{}, errors.New("Google 翻译响应无效")
	}
	var output strings.Builder
	for _, row := range rows {
		if len(row) == 0 {
			continue
		}
		var segment string
		if json.Unmarshal(row[0], &segment) != nil {
			return translation{}, errors.New("Google 翻译响应无效")
		}
		output.WriteString(segment)
	}
	if output.Len() == 0 {
		return translation{}, errors.New("翻译服务未返回译文")
	}
	return translation{output.String(), detected, target}, nil
}
func main() {
	t := &translator{client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
	_ = sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.translate", sdk.Handlers{Initialize: t.initialize, Command: t.command})
}
