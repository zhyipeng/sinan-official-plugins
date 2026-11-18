package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

func capturePlatform(ctx context.Context, path string, allowOCR bool) (captureAction, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", errors.New("无法定位 Windows 截图组件")
	}
	args := []string{path, strconv.Itoa(os.Getpid())}
	if allowOCR {
		args = append(args, "ocr")
	}
	cmd := exec.CommandContext(ctx, filepath.Join(filepath.Dir(executable), "capture-windows.exe"), args...)
	err = cmd.Run()
	if err == nil {
		return captureCompleted, nil
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	var status *exec.ExitError
	if !errors.As(err, &status) {
		return "", errors.New("无法启动 Windows 截图组件，请重新安装插件")
	}
	switch status.ExitCode() {
	case 2:
		return "", errors.New("已取消截图")
	case 7:
		return "", errors.New("屏幕像素超过截图预算")
	case 8:
		if allowOCR {
			return captureOCR, nil
		}
	}
	return "", errors.New("无法读取 Windows 显示器画面")
}
