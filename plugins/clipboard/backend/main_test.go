package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	protocol "sinan/packages/plugin-protocol"
	"strings"
	"testing"
)

func textContent(value string) content { return content{"text", []byte(value)} }
func TestHistoryPersistsDeduplicatesAndEvicts(t *testing.T) {
	dir := t.TempDir()
	h := &history{}
	if err := h.load(dir); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxItems+3; i++ {
		if err := h.capture(textContent(fmt.Sprintf("fixture-%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	if len(h.items) != maxItems {
		t.Fatal("retention count")
	}
	removed := digest(textContent("fixture-0"))
	if _, err := os.Stat(filepath.Join(dir, removed+".clip")); !os.IsNotExist(err) {
		t.Fatal("evicted content retained")
	}
	if err := h.capture(textContent("fixture-5")); err != nil {
		t.Fatal(err)
	}
	if len(h.items) != maxItems || h.items[0].ID != digest(textContent("fixture-5")) {
		t.Fatal("deduplication did not promote")
	}
	next := &history{}
	if err := next.load(dir); err != nil || len(next.items) != maxItems || next.items[0].ID != h.items[0].ID {
		t.Fatal("restart lost history")
	}
	if err := os.WriteFile(filepath.Join(dir, next.items[0].ID+".clip"), []byte("tampered fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	loaded := &history{}
	if err := loaded.load(dir); err != nil || len(loaded.items) != maxItems-1 {
		t.Fatal("tampered entry accepted")
	}
}
func TestImagesAndFullTextSearchStayWithinBridgeBudget(t *testing.T) {
	h := &history{}
	_ = h.load(t.TempDir())
	img := image.NewNRGBA(image.Rect(0, 0, 600, 400))
	for y := 0; y < 400; y++ {
		for x := 0; x < 600; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x), uint8(y), uint8(x * y), 255})
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	if err := h.capture(content{"image", b.Bytes()}); err != nil {
		t.Fatal(err)
	}
	imageID := h.items[0].ID
	r, err := h.command(context.Background(), protocol.CommandParams{CommandID: "preview", Input: imageID})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(r)
	if len(encoded) > 192<<10 {
		t.Fatal("preview exceeds bridge")
	}
	var preview struct {
		Width, Height int
		Pixels        []byte
	}
	if json.Unmarshal([]byte(r.Text), &preview) != nil || preview.Width > 160 || preview.Height > 120 || len(preview.Pixels) != preview.Width*preview.Height*4 {
		t.Fatal("invalid preview")
	}
	_ = h.capture(textContent(strings.Repeat("前", 200) + "needle"))
	r, err = h.command(context.Background(), protocol.CommandParams{CommandID: "list", Input: "needle"})
	if err != nil || !strings.Contains(r.Text, h.items[0].ID) {
		t.Fatal("search only matched summary")
	}
	for _, c := range []content{textContent(strings.Repeat("x", maxText+1)), {"image", []byte("invalid fixture")}, textContent("a\x00b")} {
		before := len(h.items)
		_ = h.capture(c)
		if len(h.items) != before {
			t.Fatal("invalid content retained")
		}
	}
}
func TestDeleteClearAndCorruptIndex(t *testing.T) {
	h := &history{}
	dir := t.TempDir()
	_ = h.load(dir)
	_ = h.capture(textContent("fixture"))
	id := h.items[0].ID
	r, err := h.command(context.Background(), protocol.CommandParams{CommandID: "delete", Input: id})
	if err != nil || r.Text != "null" || len(h.items) != 0 {
		t.Fatal("delete failed")
	}
	if _, err := os.Stat(filepath.Join(dir, id+".clip")); !os.IsNotExist(err) {
		t.Fatal("deleted bytes retained")
	}
	_ = h.capture(textContent("next fixture"))
	_, _ = h.command(context.Background(), protocol.CommandParams{CommandID: "clear"})
	next := &history{}
	if err := next.load(dir); err != nil || len(next.items) != 0 {
		t.Fatal("clear not durable")
	}
	_ = os.WriteFile(filepath.Join(dir, "history.json"), []byte("broken fixture"), 0600)
	if (&history{}).load(dir) == nil {
		t.Fatal("corrupt index overwritten")
	}
}
