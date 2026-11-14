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

func clipCommand(input []byte, limit int, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
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
	wayland := os.Getenv("WAYLAND_DISPLAY") != ""
	var types []byte
	var err error
	if wayland {
		types, err = clipCommand(nil, 4096, "wl-paste", "--list-types")
	} else {
		types, err = clipCommand(nil, 4096, "xclip", "-selection", "clipboard", "-t", "TARGETS", "-o")
	}
	if err != nil {
		return content{}, previous, err
	}
	kind := "text"
	mime := "UTF8_STRING"
	if bytes.Contains(types, []byte("image/png")) {
		kind = "image"
		mime = "image/png"
	} else if wayland {
		mime = "text/plain;charset=utf-8"
	}
	var data []byte
	if wayland {
		data, err = clipCommand(nil, maxImage, "wl-paste", "--no-newline", "--type", mime)
	} else {
		data, err = clipCommand(nil, maxImage, "xclip", "-selection", "clipboard", "-t", mime, "-o")
	}
	return content{kind, data}, previous, err
}
func writeClipboard(c content) error {
	mime := "text/plain;charset=utf-8"
	if c.Kind == "image" {
		mime = "image/png"
	}
	// Clipboard owners fork to retain the selection; stdin carries the content.
	var args []string
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		args = []string{"wl-copy", "--type", mime}
	} else {
		args = []string{"xclip", "-selection", "clipboard", "-t", mime}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Stdin = bytes.NewReader(c.Data)
	return cmd.Run()
}
