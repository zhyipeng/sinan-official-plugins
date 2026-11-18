package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

func capturePlatform(ctx context.Context, path string, allowOCR bool) (captureAction, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", errors.New("无法定位 macOS 截图组件")
	}
	helper := filepath.Join(filepath.Dir(executable), "capture-macos")
	args := []string{path}
	if allowOCR {
		args = append(args, "ocr")
	}
	err = exec.CommandContext(ctx, helper, args...).Run()
	if err == nil {
		return captureCompleted, nil
	}
	if ctx.Err() != nil {
		return "", errors.New("截图已取消或超时")
	}
	var result *exec.ExitError
	if !errors.As(err, &result) {
		return "", errors.New("无法启动 macOS 截图组件，请重新安装截图插件")
	}
	switch result.ExitCode() {
	case 2:
		return "", errors.New("已取消截图")
	case 3:
		// The helper reports this only on macOS versions without single-frame capture.
		return captureLegacyCopy, run(ctx, "/usr/sbin/screencapture", "-i", "-s", "-x", "-t", "png", path)
	case 4:
		return "", errors.New("请在系统设置的隐私与安全性中允许屏幕录制")
	case 6:
		return "", errors.New("无法生成截图图片")
	case 7:
		return "", errors.New("显示器截图超过像素上限（单屏 3200 万，合计 9600 万）")
	case 8:
		if !allowOCR {
			return "", errors.New("OCR 交接未启用")
		}
		return captureOCR, nil
	default:
		return "", errors.New("无法读取显示器画面")
	}
}
