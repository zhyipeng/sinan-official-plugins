package main

import (
	"context"
	"errors"
	protocol "sinan/packages/plugin-protocol"
)

func (h *history) readClipboard(previous uint64) (content, uint64, error) {
	result, err := h.host.ClipboardRead(context.Background(), previous)
	if err != nil {
		return content{}, previous, err
	}
	return content{Kind: result.Content.Kind, Data: result.Content.Data}, result.Sequence, nil
}
func (h *history) writeClipboard(ctx context.Context, c content) error {
	return h.host.ClipboardWrite(ctx, protocol.ClipboardContent{Kind: c.Kind, Data: c.Data})
}
func clipboardStatus(err error) string {
	var rpc *protocol.Error
	if errors.As(err, &rpc) {
		return rpc.Message
	}
	return "无法访问宿主剪贴板，请检查宿主版本、权限与系统依赖"
}
