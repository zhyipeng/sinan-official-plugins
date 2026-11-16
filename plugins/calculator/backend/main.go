package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
	"slices"
	"sync"
)

var clipboardMu sync.Mutex

func command(ctx context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
	return handleCommand(ctx, p, copyText)
}
func handleCommand(ctx context.Context, p protocol.CommandParams, copy func(context.Context, string) error) (protocol.CommandResult, error) {
	switch p.CommandID {
	case "evaluate":
		var rows []string
		if len(p.Input) > 64<<10 || json.Unmarshal([]byte(p.Input), &rows) != nil || len(rows) > 100 {
			return protocol.CommandResult{}, errors.New("计算行数或内容超出限制")
		}
		results := make([]calculation, len(rows))
		for i, row := range rows {
			if err := ctx.Err(); err != nil {
				return protocol.CommandResult{}, err
			}
			results[i] = evaluate(row, false)
		}
		b, err := json.Marshal(results)
		return protocol.CommandResult{Text: string(b)}, err
	case "copy":
		result := evaluate(p.Input, false)
		if result.Result == "" {
			return protocol.CommandResult{}, errors.New("表达式无效，无法复制")
		}
		clipboardMu.Lock()
		defer clipboardMu.Unlock()
		if err := ctx.Err(); err != nil {
			return protocol.CommandResult{}, err
		}
		if err := copy(ctx, result.Result); err != nil {
			return protocol.CommandResult{}, err
		}
		return protocol.CommandResult{Text: result.Result, Dismiss: true}, nil
	}
	return protocol.CommandResult{}, errors.New("不支持的命令")
}
func search(ctx context.Context, p protocol.SearchParams) (protocol.SearchResult, error) {
	out := protocol.SearchResult{Items: []protocol.SearchItem{}}
	if err := ctx.Err(); err != nil {
		return out, err
	}
	if p.ProviderID != "expressions" || p.Limit < 1 {
		return out, nil
	}
	result := evaluate(p.Query, true)
	if result.Result != "" {
		out.Items = append(out.Items, protocol.SearchItem{ID: "result", Title: result.Result, Subtitle: p.Query + " = " + result.Result + " · 回车复制", CommandID: "copy", Input: p.Query, Score: 1})
	}
	return out, nil
}
func main() {
	if sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.calculator", sdk.Handlers{Initialize: func(p protocol.InitializeParams) error {
		if !slices.Contains(p.HostCapabilities, protocol.ClipboardCapability) {
			return errors.New("宿主缺少 clipboard.v1 能力")
		}
		return nil
	}, Command: command, Search: search}) != nil {
		os.Exit(1)
	}
}
