package main

import (
	"context"
	"encoding/json"
	"github.com/abadojack/whatlanggo"
	"io"
	"net/http"
	protocol "sinan/packages/plugin-protocol"
	"strings"
	"testing"
	"time"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fixture(t *testing.T, fn transport) *translator {
	t.Helper()
	tr := &translator{client: &http.Client{Transport: fn}}
	if err := tr.initialize(protocol.InitializeParams{}); err != nil {
		t.Fatal(err)
	}
	return tr
}
func response(body string) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}
func TestGoogleSmartTargetAndSegments(t *testing.T) {
	count := 0
	firstTarget := "zh-CN"
	tr := fixture(t, func(r *http.Request) (*http.Response, error) {
		count++
		q := r.URL.Query()
		if q.Get("q") != "你好" {
			t.Error("input changed")
		}
		if count == 1 && q.Get("tl") != firstTarget || count == 2 && q.Get("tl") != "en" {
			t.Error("wrong smart target")
		}
		return response(`[[["Hello","你好"],[" world","世界"]],null,"zh-CN"]`), nil
	})
	v, err := tr.translate(context.Background(), request{"你好", "auto", "smart", "google"}, "zh-CN")
	if err != nil || v.Target != "en" || v.Text != "Hello world" || count != 2 {
		t.Fatalf("unexpected result: %+v %v", v, err)
	}
	count = 0
	firstTarget = "zh-TW"
	v, err = tr.translate(context.Background(), request{"你好", "auto", "zh-TW", "google"}, "zh-CN")
	if err != nil || v.Target != "zh-TW" || count != 1 {
		t.Fatal("explicit target was overridden")
	}
}
func TestMyMemoryDetectionAndErrors(t *testing.T) {
	tr := fixture(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Query().Get("langpair") != "zh-CN|en" {
			t.Error("wrong detected pair")
		}
		return response(`{"responseStatus":200,"responseData":{"translatedText":"Hello &amp; goodbye"}}`), nil
	})
	v, err := tr.translate(context.Background(), request{"这是一个中文句子。", "auto", "smart", "mymemory"}, "zh-CN")
	if err != nil || v.Text != "Hello & goodbye" || v.Target != "en" {
		t.Fatalf("%+v %v", v, err)
	}
	for _, body := range []string{`{"responseStatus":403}`, `{"responseStatus":200,"quotaFinished":true}`, `{"responseStatus":200}`, `<html>blocked</html>`, strings.Repeat("x", (256<<10)+1)} {
		tr.client.Transport = transport(func(*http.Request) (*http.Response, error) { return response(body), nil })
		if _, err := tr.translate(context.Background(), request{"hello", "en", "zh-CN", "mymemory"}, "zh-CN"); err == nil {
			t.Fatal("invalid response accepted")
		}
	}
}
func call(t *testing.T, tr *translator, id, input string) map[string]json.RawMessage {
	t.Helper()
	v, e := tr.command(context.Background(), protocol.CommandParams{CommandID: id, Input: input})
	if e != nil {
		t.Fatal(e)
	}
	var out map[string]json.RawMessage
	if json.Unmarshal([]byte(v.Text), &out) != nil {
		t.Fatal("bad command result")
	}
	return out
}
func TestValidationSettingsAndJobCancellation(t *testing.T) {
	cancelled := make(chan struct{}, 1)
	tr := fixture(t, func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		cancelled <- struct{}{}
		return nil, r.Context().Err()
	})
	tr.initialize(protocol.InitializeParams{Settings: map[string][]string{"target-language": {"ja"}, "default-engine": {"mymemory"}}})
	if tr.target != "ja" || tr.engine != "mymemory" {
		t.Fatal("settings ignored")
	}
	for _, r := range []request{{"", "auto", "smart", "google"}, {strings.Repeat("中", 167), "auto", "smart", "mymemory"}, {"hello", "xx", "smart", "google"}, {"hello", "auto", "bad", "google"}, {"hello", "auto", "smart", "bad"}, {strings.Repeat("a", 5001), "auto", "smart", "google"}} {
		b, _ := json.Marshal(r)
		if call(t, tr, "translate", string(b))["error"] == nil {
			t.Fatal("invalid input accepted")
		}
	}
	b, _ := json.Marshal(request{"hello", "auto", "smart", "google"})
	start := time.Now()
	v := call(t, tr, "translate", string(b))
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("network blocked bridge")
	}
	var id string
	json.Unmarshal(v["id"], &id)
	if id == "" {
		t.Fatal("no job")
	}
	// Give the worker a bounded chance to start; cancelling before HTTP starts is valid too.
	call(t, tr, "cancel", id)
	if call(t, tr, "poll", id)["error"] == nil {
		t.Fatal("cancelled job retained")
	}
	select {
	case <-cancelled:
	case <-time.After(100 * time.Millisecond):
	}
}
func TestAsyncCompletionAndQuota(t *testing.T) {
	tr := fixture(t, func(*http.Request) (*http.Response, error) { return response(`[[["你好","hello"]],null,"en"]`), nil })
	b, _ := json.Marshal(request{"hello", "auto", "smart", "google"})
	var id string
	json.Unmarshal(call(t, tr, "translate", string(b))["id"], &id)
	deadline := time.Now().Add(time.Second)
	for {
		v := call(t, tr, "poll", id)
		if string(v["done"]) == "true" {
			if v["result"] == nil {
				t.Fatal("missing translation")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job never completed")
		}
		time.Sleep(time.Millisecond)
	}
	for range 3 {
		call(t, tr, "translate", string(b))
	}
	if call(t, tr, "translate", string(b))["error"] == nil {
		t.Fatal("task budget not enforced")
	}
	tr.mu.Lock()
	for _, j := range tr.jobs {
		j.cancel()
	}
	tr.mu.Unlock()
}
func TestGoogleRejectsMalformedResponse(t *testing.T) {
	for _, body := range []string{`[]`, `[null,null,"en"]`, `[[[123]],null,"en"]`, `[[["ok"]],null,""]`} {
		tr := fixture(t, func(*http.Request) (*http.Response, error) { return response(body), nil })
		if _, err := tr.google(context.Background(), "hello", "auto", "zh-CN"); err == nil {
			t.Fatal("accepted malformed response")
		}
	}
}

func TestDefaultAndCanonicalLanguageSettings(t *testing.T) {
	tr := fixture(t, nil)
	if tr.target != "zh-CN" || tr.engine != "mymemory" {
		t.Fatal("incorrect defaults")
	}
	tr.initialize(protocol.InitializeParams{Settings: map[string][]string{"target-language": {"zh-tw"}}})
	if tr.target != "zh-TW" {
		t.Fatal("manifest option not mapped to service language")
	}
}

func TestMyMemorySingleEnglishWord(t *testing.T) {
	for _, text := range []string{"hello", "apple", "world", "plugin", "translate", "language", "test", "API", "I", "don't", "e-mail", "  Hello!  ", "“Hello”", "don’t"} {
		t.Run(text, func(t *testing.T) {
			calls := 0
			tr := fixture(t, func(r *http.Request) (*http.Response, error) {
				calls++
				if pair := r.URL.Query().Get("langpair"); pair != "en|zh-CN" {
					t.Fatalf("language pair = %q", pair)
				}
				if r.URL.Query().Get("q") != text {
					t.Fatal("original input changed")
				}
				return response(`{"responseStatus":200,"responseData":{"translatedText":"示例译文"}}`), nil
			})
			v, err := tr.translate(context.Background(), request{text, "auto", "smart", "mymemory"}, "zh-CN")
			if err != nil || v.Source != "en" || v.Text != "示例译文" || calls != 1 {
				t.Fatalf("unexpected translation: %+v, %v", v, err)
			}
		})
	}
}

func TestSingleWordExplicitSourceTakesPrecedence(t *testing.T) {
	tr := fixture(t, func(r *http.Request) (*http.Response, error) {
		if pair := r.URL.Query().Get("langpair"); pair != "fr|zh-CN" {
			t.Fatalf("explicit language ignored: %s", pair)
		}
		return response(`{"responseStatus":200,"responseData":{"translatedText":"你好"}}`), nil
	})
	if _, err := tr.translate(context.Background(), request{"bonjour", "fr", "smart", "mymemory"}, "zh-CN"); err != nil {
		t.Fatal(err)
	}
}

func TestEnglishWordRulePreservesOtherLanguages(t *testing.T) {
	for _, text := range []string{
		"这是一个中文句子。", "こんにちは、今日はいい天気ですね。",
		"안녕하세요. 만나서 반갑습니다.", "Это предложение написано на русском языке.",
		"Ceci est une phrase française avec plusieurs mots.", "café", "über", "123", "😀", "hello world",
	} {
		expected := whatlanggo.Detect(text).Lang.Iso6391()
		if expected == "zh" {
			expected = "zh-CN"
		}
		if got := detect(text); got != expected {
			t.Errorf("detect(%q)=%q, want original detector result %q", text, got, expected)
		}
	}
}
