//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxClipboardDependenciesAndCommands(t *testing.T) {
	t.Setenv("DISPLAY", ":fixture")
	t.Setenv("WAYLAND_DISPLAY", "")
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	if _, err := clipboardProgram(true); err == nil || clipboardStatus(err) != "请安装 xclip 以使用 X11 剪贴板" {
		t.Fatal("X11 dependency not reported")
	}
	capture := filepath.Join(dir, "captured")
	t.Setenv("CLIPBOARD_TEST_CAPTURE", capture)
	script := []byte("#!/bin/sh\ncase \"$*\" in\n *TARGETS*|*--list-types*) printf 'text/plain\\n';;\n *' -o'*|*--no-newline*) printf 'fixture\\r\\n';;\n *) /bin/cat > \"$CLIPBOARD_TEST_CAPTURE\";;\nesac\n")
	for _, name := range []string{"xclip", "wl-paste", "wl-copy"} {
		if err := os.WriteFile(filepath.Join(dir, name), script, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, wayland := range []string{"", "wayland-fixture"} {
		t.Setenv("WAYLAND_DISPLAY", wayland)
		c, _, err := readClipboard(0)
		if err != nil || c.Kind != "text" || string(c.Data) != "fixture\r\n" {
			t.Fatal("clipboard read changed text", err)
		}
		if err = writeClipboard(textContent("write fixture")); err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(capture)
		if err != nil || string(b) != "write fixture" {
			t.Fatal("clipboard write did not use stdin")
		}
	}
}
