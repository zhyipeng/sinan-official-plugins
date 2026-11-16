//go:build darwin || linux

package main

import (
	"errors"
	"testing"
)

func TestClipboardSelection(t *testing.T) {
	for _, tc := range []struct{ os, display, wayland, want string }{{"darwin", "", "", "/usr/bin/pbcopy"}, {"linux", ":0", "", "xclip"}, {"linux", ":0", "wayland-0", "wl-copy"}, {"linux", "", "", ""}} {
		env := func(k string) string {
			if k == "DISPLAY" {
				return tc.display
			}
			return tc.wayland
		}
		path, _, err := clipboardCommand(tc.os, env, func(s string) (string, error) { return s, nil })
		if path != tc.want || (err != nil) != (tc.want == "") {
			t.Fatalf("%+v %s %v", tc, path, err)
		}
	}
	if _, _, err := clipboardCommand("linux", func(string) string { return "wayland" }, func(string) (string, error) { return "", errors.New("missing") }); err == nil {
		t.Fatal("missing dependency accepted")
	}
}
