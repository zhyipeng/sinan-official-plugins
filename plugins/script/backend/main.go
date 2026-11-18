package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
)

type plugin struct {
	mu       sync.RWMutex
	dir      string
	cfg      configuration
	revision uint64
	cached   catalog
	scanned  time.Time
	scanning chan struct{}
	runs     map[string]*scriptRun
	jobs     map[string]*scriptRun
	notifyMu sync.Mutex
	notify   func(context.Context, protocol.NotificationParams) error
}

type listRequest struct {
	Query   string `json:"query"`
	Offset  int    `json:"offset"`
	Refresh bool   `json:"refresh"`
}

func (p *plugin) environments() []environment {
	p.mu.RLock()
	manual := p.cfg.Environments
	p.mu.RUnlock()
	return append(discover(), manual...)
}

func (p *plugin) list(ctx context.Context, request listRequest) (any, error) {
	if request.Offset < 0 || len(request.Query) > 1024 {
		return nil, errors.New("搜索条件无效")
	}
	if request.Refresh {
		p.mu.Lock()
		p.scanned = time.Time{}
		p.revision++
		p.mu.Unlock()
	}
	index, _, err := p.index(ctx)
	if err != nil {
		return nil, err
	}
	query := strings.ToLower(strings.TrimSpace(request.Query))
	envs := p.environments()
	rows := []script{}
	total := 0
	const pageSize = 12
	for _, item := range index.scripts {
		if match(item, query) == 0 {
			continue
		}
		total++
		if total <= request.Offset || len(rows) == pageSize {
			continue
		}
		if item.Exists {
			if e, err := interpreter(item, envs); err == nil {
				item.Resolved = e.Name
			}
		}
		p.mu.RLock()
		if run := p.runs[item.ID]; run != nil {
			item.Status, item.ResultID, item.Delivery = run.result.Status, run.result.ID, run.result.Delivery
		}
		p.mu.RUnlock()
		rows = append(rows, item)
	}
	return map[string]any{"items": rows, "total": total, "pageSize": pageSize, "missingDirectories": index.missing, "limited": index.limited}, ctx.Err()
}

func (p *plugin) search(ctx context.Context, request protocol.SearchParams) (protocol.SearchResult, error) {
	out := protocol.SearchResult{Items: []protocol.SearchItem{}}
	query := strings.ToLower(strings.TrimSpace(request.Query))
	if request.ProviderID != "scripts" || request.Limit < 1 || query == "" {
		return out, nil
	}
	index, _, err := p.index(ctx)
	if err != nil {
		return out, err
	}
	for _, item := range index.scripts {
		if score := match(item, query); item.Exists && !item.HideFromSearch && score > 0 {
			command := "run"
			if item.ShowOutput {
				command = "run-view"
			}
			out.Items = append(out.Items, protocol.SearchItem{
				ID: item.ID, Title: searchTitle(item.Name), Subtitle: "运行脚本 · " + searchTitle(filepath.Base(filepath.Dir(item.Path))),
				CommandID: command, Input: item.ID, Score: score,
			})
		}
	}
	slices.SortStableFunc(out.Items, func(a, b protocol.SearchItem) int {
		return cmp.Compare(b.Score, a.Score)
	})
	out.Items = out.Items[:min(len(out.Items), request.Limit, 20)]
	return out, ctx.Err()
}

func (p *plugin) change(ctx context.Context, c change) error {
	var item script
	var rev uint64
	if c.Action == "edit" || c.Action == "remove-import" {
		index, revision, err := p.index(ctx)
		if err != nil {
			return err
		}
		rev = revision
		pos := slices.IndexFunc(index.scripts, func(s script) bool { return s.ID == c.ID })
		if pos < 0 {
			return errors.New("脚本已失效，请刷新列表")
		}
		item = index.scripts[pos]
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	next := p.cfg
	var err error
	switch c.Action {
	case "add-directory", "remove-directory":
		next.Directories, err = changeDirectory(next.Directories, c)
	case "add-environment", "remove-environment":
		next.Environments, err = changeEnvironment(next.Environments, c)
	case "edit", "remove-import", "import", "create":
		if item.ID != "" && rev != p.revision {
			return errors.New("脚本列表已变化，请刷新后重试")
		}
		return p.changeScript(next, item, c)
	default:
		return errors.New("未知的脚本设置操作")
	}
	if err != nil {
		return err
	}
	return p.commit(next)
}

func (p *plugin) changeScript(next configuration, item script, c change) error {
	path := item.Path
	imported := item.Imported
	switch c.Action {
	case "import":
		var err error
		path, err = absolutePath(c.Path)
		if err != nil {
			return err
		}
		parent, err := filepath.EvalSymlinks(filepath.Dir(path))
		if err != nil {
			return errors.New("无法访问脚本所在目录")
		}
		path, err = absolutePath(filepath.Join(parent, filepath.Base(path)))
		if err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("请选择可访问的普通文件")
		}
		if next.Scripts[pathKey(path)].Imported {
			return errors.New("已导入该脚本")
		}
		imported = true
	case "create":
		if !slices.Contains(next.Directories, c.Path) {
			return errors.New("请先添加脚本目录")
		}
		if c.Name == "" || !filepath.IsLocal(c.Name) || filepath.Base(c.Name) != c.Name ||
			strings.ContainsAny(c.Name, `\/:*?"<>|`) || strings.HasSuffix(c.Name, ".") ||
			strings.TrimSpace(c.Name) != c.Name || strings.ContainsFunc(c.Name, unicode.IsControl) {
			return errors.New("请输入有效的文件名")
		}
		var err error
		path, err = absolutePath(filepath.Join(c.Path, c.Name))
		if err != nil {
			return err
		}
		imported = scriptKind(path) == ""
	}

	key := pathKey(path)
	next.Scripts = maps.Clone(next.Scripts)
	if c.Action == "remove-import" {
		if !imported {
			return errors.New("此脚本来自扫描目录")
		}
		delete(next.Scripts, key)
		return p.commit(next)
	}
	words, err := cleanKeywords(c.Keywords)
	if err != nil {
		return err
	}
	// An existing unavailable choice can be kept while editing keywords.
	if c.Environment != "" && c.Environment != direct && c.Environment != item.Environment {
		envs := append(discover(), next.Environments...)
		if !slices.ContainsFunc(envs, func(e environment) bool { return e.ID == c.Environment }) {
			return errEnvironment
		}
	}
	if c.Action == "create" && len(c.Text) > 32<<10 {
		return errors.New("脚本初始内容超过 32 KiB")
	}
	options := next.Scripts[key]
	options.Path, options.Environment, options.Keywords, options.Imported = path, c.Environment, words, imported
	if c.HideFromSearch != nil {
		options.HideFromSearch = *c.HideFromSearch
	}
	if c.ShowOutput != nil {
		options.ShowOutput = *c.ShowOutput
	}
	if imported || c.Environment != "" || len(words) != 0 || options.HideFromSearch || options.ShowOutput {
		next.Scripts[key] = options
	} else {
		delete(next.Scripts, key)
	}
	if len(next.Scripts) > maxOverrides {
		return errors.New("导入及自定义脚本数量已达上限")
	}
	if c.Action == "create" {
		return p.create(next, c, imported)
	}
	return p.commit(next)
}

func (p *plugin) create(next configuration, c change, imported bool) error {
	root, err := os.OpenRoot(c.Path)
	if err != nil {
		return errors.New("无法访问脚本目录")
	}
	defer root.Close()
	mode := os.FileMode(0600)
	if c.Environment == direct || (c.Environment == "" && imported) {
		mode = 0700
	}
	file, err := root.OpenFile(c.Name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if os.IsExist(err) {
		return errors.New("同名文件已经存在")
	}
	if err != nil {
		return errors.New("无法创建脚本")
	}
	info, _ := file.Stat()
	finished := false
	defer func() {
		if !finished && info != nil {
			if current, err := root.Lstat(c.Name); err == nil && os.SameFile(info, current) {
				_ = root.Remove(c.Name)
			}
		}
	}()
	_, writeErr := file.WriteString(c.Text)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return errors.New("无法写入脚本")
	}
	if err := p.commit(next); err != nil {
		return err
	}
	finished = true
	return nil
}

func marshal(value any, err error) (protocol.CommandResult, error) {
	if err != nil {
		value = map[string]string{"error": err.Error()}
	}
	data, err := json.Marshal(value)
	return protocol.CommandResult{Text: string(data)}, err
}

func (p *plugin) command(ctx context.Context, cmd protocol.CommandParams) (protocol.CommandResult, error) {
	switch cmd.CommandID {
	case "settings":
		p.mu.RLock()
		dirs, manual := p.cfg.Directories, p.cfg.Environments
		p.mu.RUnlock()
		return marshal(map[string]any{"directories": dirs, "manual": manual, "automatic": discover()}, nil)
	case "list":
		var req listRequest
		if json.Unmarshal([]byte(cmd.Input), &req) != nil {
			return marshal(nil, errors.New("搜索参数无效"))
		}
		return marshal(p.list(ctx, req))
	case "change":
		var c change
		if json.Unmarshal([]byte(cmd.Input), &c) != nil {
			return marshal(nil, errors.New("设置参数无效"))
		}
		return marshal(nil, p.change(ctx, c))
	case "start", "start-output":
		source := "library"
		if cmd.CommandID == "start-output" {
			source = "output"
		}
		return marshal(p.start(ctx, cmd.Input, source))
	case "run-status":
		return marshal(p.runStatus(cmd.Input))
	case "run":
		result, err := p.start(ctx, cmd.Input, "search")
		if err != nil {
			return protocol.CommandResult{Text: err.Error()}, nil
		}
		if result.Status == failed {
			return protocol.CommandResult{Text: result.Detail}, nil
		}
		return protocol.CommandResult{Text: "脚本已启动", Dismiss: true}, nil
	}
	return protocol.CommandResult{}, errors.New("未知命令")
}

func main() {
	p := &plugin{scanning: make(chan struct{}, 1), runs: map[string]*scriptRun{}}
	if sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.script", sdk.Handlers{
		HostReady: func(host *sdk.HostClient) { p.notify = host.Notify },
		Initialize: func(params protocol.InitializeParams) error {
			var err error
			p.dir = params.DataDir
			if !slices.Contains(params.HostCapabilities, protocol.NotificationsCapability) {
				p.notify = nil
			}
			p.cfg, err = loadConfig(p.dir)
			return err
		},
		Command: p.command,
		Search:  p.search,
	}) != nil {
		os.Exit(1)
	}
}
