package main

import (
	"errors"
	"testing"
)

func TestClipboardMIMEUsesExactOffers(t *testing.T) {
	for _, fixture := range []struct{ types, kind, mime string }{
		{"TARGETS UTF8_STRING text/plain", "text", "UTF8_STRING"},
		{"text/plain\nimage/png\n", "image", "image/png"},
		{"text/plain;charset=UTF-8\n", "text", "text/plain;charset=UTF-8"},
		{"application/x-image/png-backup\ntext/html", "", ""},
		{"text/plain", "text", "text/plain"},
	} {
		kind, mime := clipboardMIME(fixture.types)
		if kind != fixture.kind || mime != fixture.mime {
			t.Fatal("wrong MIME selection")
		}
	}
}
func TestClipboardStatusDoesNotExposeExternalErrors(t *testing.T) {
	if clipboardStatus(errors.New("arbitrary external failure")) == "arbitrary external failure" {
		t.Fatal("external error exposed")
	}
	const expected clipboardSupportError = "请安装 xclip"
	if clipboardStatus(expected) != string(expected) {
		t.Fatal("dependency guidance lost")
	}
}
