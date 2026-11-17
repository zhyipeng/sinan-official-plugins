package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// Capture files are private and never placed in the package or user screenshot directory.
func captureRegion(ctx context.Context) ([]byte, error) {
	dir, err := os.MkdirTemp("", "sinan-capture-")
	if err != nil {
		return nil, errors.New("无法创建截图临时目录")
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "capture.png")
	if err := capturePlatform(ctx, path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("已取消截图或未生成图片")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > maxImage {
		return nil, errors.New("截图超过 8 MiB，请缩小选区")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("无法读取截图")
	}
	return data, nil
}
func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	configureProcess(cmd)
	// Do not forward native output (it may include private paths) to RPC stdout.
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return errors.New("截图已取消或超时")
		}
		return errors.New("截图已取消、权限被拒或系统工具不可用")
	}
	return nil
}
