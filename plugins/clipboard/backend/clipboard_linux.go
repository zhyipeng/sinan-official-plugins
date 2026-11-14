//go:build linux

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"time"
)

func clipboardProgram(read bool) (string, error) {
	command := "xclip"
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		command = "wl-copy"
		if read {
			command = "wl-paste"
		}
	} else if os.Getenv("DISPLAY") == "" {
		return "", clipboardSupportError("未检测到 X11 或 Wayland 桌面剪贴板")
	}
	path, err := exec.LookPath(command)
	if err != nil {
		if command == "xclip" {
			return "", clipboardSupportError("请安装 xclip 以使用 X11 剪贴板")
		}
		return "", clipboardSupportError("请安装 wl-clipboard 以使用 Wayland 剪贴板")
	}
	return path, nil
}
func clipCommand(limit int, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(pipe, int64(limit+1)))
	if len(data) > limit {
		_ = cmd.Process.Kill()
		err = errors.New("clipboard too large")
	}
	wait := cmd.Wait()
	if err != nil {
		return nil, err
	}
	return data, wait
}
func readClipboard(previous uint64) (content, uint64, error) {
	program, err := clipboardProgram(true)
	if err != nil {
		return content{}, previous, err
	}
	wayland := os.Getenv("WAYLAND_DISPLAY") != ""
	var types []byte
	if wayland {
		types, err = clipCommand(4096, program, "--list-types")
	} else {
		types, err = clipCommand(4096, program, "-selection", "clipboard", "-t", "TARGETS", "-o")
	}
	// Both tools use exit 1 when there is no current selection owner.
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 && len(types) == 0 {
			return content{}, previous, nil
		}
		return content{}, previous, err
	}
	kind, mime := clipboardMIME(string(types))
	if kind == "" {
		return content{}, previous, nil
	}
	limit := maxText
	if kind == "image" {
		limit = maxImage
	}
	var data []byte
	if wayland {
		data, err = clipCommand(limit, program, "--no-newline", "--type", mime)
	} else {
		data, err = clipCommand(limit, program, "-selection", "clipboard", "-t", mime, "-o")
	}
	return content{kind, data}, previous, err
}
func writeClipboard(c content) error {
	if _, _, err := validate(c); err != nil {
		return err
	}
	program, err := clipboardProgram(false)
	if err != nil {
		return err
	}
	mime := "text/plain;charset=utf-8"
	if c.Kind == "image" {
		mime = "image/png"
	}
	args := []string{"-selection", "clipboard", "-t", mime}
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		args = []string{"--type", mime}
	}
	// The utility forks its selection owner. Never connect it to plugin stdio.
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Stdin = bytes.NewReader(c.Data)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return cmd.Run()
}
