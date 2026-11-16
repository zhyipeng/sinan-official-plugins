package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"

	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
)

func (s *service) command(ctx context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
	if err := ctx.Err(); err != nil {
		return protocol.CommandResult{}, err
	}
	var value snapshot
	switch p.CommandID {
	case "start":
		if p.Input != "" {
			return protocol.CommandResult{}, errors.New("识别不接受外部路径或图片参数")
		}
		value = s.startImage(p.Image)
	case "poll", "cancel":
		if len(p.Input) != 32 {
			return protocol.CommandResult{}, errors.New("任务标识无效")
		}
		if p.CommandID == "poll" {
			value = s.poll(p.Input)
		} else {
			value = s.cancel(p.Input)
		}
	default:
		return protocol.CommandResult{}, errors.New("不支持的命令")
	}
	data, err := json.Marshal(value)
	return protocol.CommandResult{Text: string(data)}, err
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	root := filepath.Dir(filepath.Dir(executable))
	var host *sdk.HostClient
	s := newService(func(ctx context.Context) ([]byte, error) {
		value, err := host.ClipboardRead(ctx, 0)
		if err != nil {
			return nil, errors.New("无法读取剪贴板图片，请检查系统剪贴板服务")
		}
		if value.Content.Kind != "image" {
			return nil, errors.New("请先截图或复制一张图片")
		}
		return value.Content.Data, nil
	}, func(ctx context.Context, data []byte) (string, error) { return runWorker(ctx, root, data) })
	go s.maintain()
	err = sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.ocr", sdk.Handlers{
		HostReady: func(h *sdk.HostClient) { host = h },
		Initialize: func(p protocol.InitializeParams) error {
			if !slices.Contains(p.HostCapabilities, protocol.ClipboardCapability) || !slices.Contains(p.HostCapabilities, protocol.ImageCommandCapability) {
				return errors.New("宿主缺少 clipboard.v1 或 ui.image-command.v1 能力，请升级宿主")
			}
			return nil
		}, Command: s.command,
	})
	s.close()
	if err != nil {
		os.Exit(1)
	}
}
