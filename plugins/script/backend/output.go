package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	protocol "sinan/packages/plugin-protocol"
)

const outputPreviewLimit = 16 << 10

// Both stdout and stderr use the same writer and a bounded in-memory preview.
type outputCapture struct {
	mu         sync.Mutex
	file       *os.File
	path       string
	preview    []byte
	size       int
	incomplete bool
}

func newOutputCapture() *outputCapture {
	c := &outputCapture{}
	if file, err := os.CreateTemp("", "sinan-script-*.log"); err == nil {
		c.file, c.path = file, file.Name()
	}
	return c
}

func (c *outputCapture) Write(data []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.preview = append(c.preview, data[:min(len(data), outputPreviewLimit-len(c.preview))]...)
	if c.file != nil {
		n, err := c.file.Write(data)
		if err != nil || n < len(data) {
			c.incomplete = true
		}
	}
	c.size += len(data)
	return len(data), nil
}

func (c *outputCapture) finish() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.file != nil {
		c.incomplete = c.file.Close() != nil || c.incomplete
		c.file = nil
	}
}

func (c *outputCapture) remove() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.path != "" {
		_ = os.Remove(c.path)
		c.path = ""
	}
}

func (c *outputCapture) view() (text string, size int, path string, incomplete bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.ToValidUTF8(string(c.preview), "�"), c.size, c.path, c.incomplete
}

func limitText(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	end := maxBytes - len("…")
	for !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end] + "…"
}

func notificationText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return ' '
		}
		return r
	}, value))
}

func resultNotification(result runResult, size int) (protocol.NotificationParams, bool) {
	status := "执行成功"
	if result.Status == failed {
		status = "执行失败"
	}
	body := notificationText(result.Output)
	if body == "" {
		body = "无输出"
	}
	combine := func(text string) string {
		if result.Detail != "" && text == "无输出" {
			return result.Detail
		}
		if result.Detail != "" {
			return result.Detail + "\n" + text
		}
		return text
	}
	long := size > protocol.NotificationMaxBodyBytes || len(combine(body)) > protocol.NotificationMaxBodyBytes || result.Incomplete
	if long {
		switch {
		case result.Path == "":
			body = "无法提供完整输出，请在脚本管理页查看预览。"
		case result.Incomplete:
			body = "输出未完整保存，请查看临时日志：" + result.Path
		default:
			body = "输出过长，请查看临时日志：" + result.Path
		}
		if len(combine(body)) > protocol.NotificationMaxBodyBytes && result.Path != "" {
			body = "请在系统临时目录查看 " + filepath.Base(result.Path)
		}
	}
	return protocol.NotificationParams{
		Title: limitText(status+" · "+result.Name, protocol.NotificationMaxTitleBytes),
		Body:  limitText(notificationText(combine(body)), protocol.NotificationMaxBodyBytes),
	}, long
}
