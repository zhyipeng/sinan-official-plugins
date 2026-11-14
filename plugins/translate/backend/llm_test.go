package main

import (
	"strings"
	"testing"
)

func TestLLMPluginOnlyPreparesPrompt(t *testing.T) {
	for _, tc := range []struct{ text, source, target, want string }{{"hello", "auto", "smart", "zh-CN"}, {"这是一个中文句子。", "auto", "smart", "en"}, {"hello", "en", "ja", "ja"}} {
		p, err := prepareLLM(request{tc.text, tc.source, tc.target, "llm"}, "zh-CN")
		if err != nil || p.Target != tc.want || p.Input != tc.text || !strings.Contains(p.SystemPrompt, "("+tc.want+")") {
			t.Fatal("invalid translation prompt")
		}
	}
	for _, r := range []request{{"", "auto", "smart", "llm"}, {"hello", "bad", "smart", "llm"}, {"hello", "auto", "bad", "llm"}} {
		if _, err := prepareLLM(r, "zh-CN"); err == nil {
			t.Fatal("invalid prompt request accepted")
		}
	}
}
