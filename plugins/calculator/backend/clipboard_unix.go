//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func clipboardCommand(goos string, getenv func(string) string, lookPath func(string) (string, error)) (string, []string, error) {
	if goos == "darwin" {
		return "/usr/bin/pbcopy", nil, nil
	}
	name := "xclip"
	args := []string{"-selection", "clipboard", "-t", "text/plain;charset=utf-8"}
	if getenv("WAYLAND_DISPLAY") != "" {
		name = "wl-copy"
		args = []string{"--type", "text/plain;charset=utf-8"}
	} else if getenv("DISPLAY") == "" {
		return "", nil, errors.New("未检测到 X11 或 Wayland 桌面剪贴板")
	}
	path, err := lookPath(name)
	if err != nil {
		if name == "xclip" {
			return "", nil, errors.New("复制需要安装 xclip")
		}
		return "", nil, errors.New("复制需要安装 wl-clipboard")
	}
	return path, args, nil
}
func copyText(ctx context.Context, text string) error {
	program, args, err := clipboardCommand(runtime.GOOS, os.Getenv, exec.LookPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 350*time.Millisecond)
	defer cancel()
	// Detached selection owners must never inherit the JSON-RPC pipes.
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Stdin = strings.NewReader(text)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		return errors.New("剪贴板写入失败，请检查桌面剪贴板服务")
	}
	return nil
}
