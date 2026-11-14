package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
)

const maxItems = 200
const maxText = 256 << 10
const maxImage = 8 << 20
const maxTotal = 64 << 20

type content struct {
	Kind string `json:"kind"`
	Data []byte `json:"data"`
}
type item struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Text    string `json:"text,omitempty"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
	Created int64  `json:"created"`
	Size    int    `json:"size"`
}
type history struct {
	mu       sync.Mutex
	dir      string
	items    []item
	last     string
	status   string
	sequence uint64
}

func digest(c content) string {
	sum := sha256.Sum256(append([]byte(c.Kind+":"), c.Data...))
	return hex.EncodeToString(sum[:])
}
func validate(c content) (int, int, error) {
	if c.Kind == "text" && len(c.Data) > 0 && len(c.Data) <= maxText && utf8.Valid(c.Data) && !bytes.ContainsRune(c.Data, 0) {
		return 0, 0, nil
	}
	if c.Kind == "image" && len(c.Data) > 0 && len(c.Data) <= maxImage {
		cfg, err := png.DecodeConfig(bytes.NewReader(c.Data))
		if err == nil && cfg.Width > 0 && cfg.Height > 0 && int64(cfg.Width)*int64(cfg.Height) <= 16_000_000 {
			return cfg.Width, cfg.Height, nil
		}
	}
	return 0, 0, errors.New("剪贴板内容无效或超出限制")
}
func atomicFile(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	// Use platform replacement semantics so the durable index remains atomic.
	return moveFile(name, path)
}
func (h *history) save() error {
	b, _ := json.Marshal(h.items)
	return replaceIndex(filepath.Join(h.dir, "history.json"), b)
}
func (h *history) load(dir string) error {
	if dir == "" {
		return errors.New("宿主未提供持久目录")
	}
	h.dir = dir
	h.items = []item{}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errors.New("无法创建历史目录")
	}
	index, err := os.Open(filepath.Join(dir, "history.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("无法读取历史索引")
	}
	defer index.Close()
	b, err := io.ReadAll(io.LimitReader(index, (2<<20)+1))
	if err != nil || len(b) > 2<<20 {
		return errors.New("无法读取历史索引")
	}
	var saved []item
	if json.Unmarshal(b, &saved) != nil {
		return errors.New("历史索引已损坏")
	}
	total := 0
	seen := map[string]bool{}
	for _, v := range saved {
		if len(h.items) >= maxItems || !validID(v.ID) || seen[v.ID] {
			continue
		}
		c, e := h.read(v)
		if e != nil {
			continue
		}
		w, hh, e := validate(c)
		if e != nil || digest(c) != v.ID || total+len(c.Data) > maxTotal {
			continue
		}
		v.Width = w
		v.Height = hh
		v.Size = len(c.Data)
		if c.Kind == "text" {
			v.Text = previewText(string(c.Data))
		} else {
			v.Text = ""
		}
		h.items = append(h.items, v)
		seen[v.ID] = true
		total += v.Size
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".clip") && validID(strings.TrimSuffix(name, ".clip")) && !seen[strings.TrimSuffix(name, ".clip")] {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
	return nil
}
func validID(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}
func previewText(s string) string {
	r := []rune(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s))
	if len(r) > 160 {
		return string(r[:160]) + "…"
	}
	return s
}
func (h *history) read(v item) (content, error) {
	if !validID(v.ID) || (v.Kind != "text" && v.Kind != "image") {
		return content{}, errors.New("无效条目")
	}
	f, err := os.Open(filepath.Join(h.dir, v.ID+".clip"))
	if err != nil {
		return content{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxImage+1))
	if err != nil {
		return content{}, err
	}
	c := content{v.Kind, data}
	if digest(c) != v.ID {
		return content{}, errors.New("条目摘要不匹配")
	}
	return c, nil
}
func (h *history) capture(c content) error {
	w, hh, err := validate(c)
	if err != nil {
		return nil
	}
	id := digest(c)
	h.mu.Lock()
	defer h.mu.Unlock()
	if id == h.last {
		return nil
	}
	old := append([]item(nil), h.items...)
	next := []item{{ID: id, Kind: c.Kind, Width: w, Height: hh, Created: time.Now().UnixMilli(), Size: len(c.Data)}}
	if c.Kind == "text" {
		next[0].Text = previewText(string(c.Data))
	}
	for _, v := range h.items {
		if v.ID != id {
			next = append(next, v)
		}
	}
	total := 0
	keep := 0
	for _, v := range next {
		if keep >= maxItems || total+v.Size > maxTotal {
			break
		}
		total += v.Size
		keep++
	}
	next = next[:keep]
	if err = atomicFile(filepath.Join(h.dir, id+".clip"), c.Data); err != nil {
		return errors.New("无法保存剪贴板条目")
	}
	h.items = next
	if err = h.save(); err != nil {
		h.items = old
		return errors.New("无法保存历史索引")
	}
	h.last = id
	retained := map[string]bool{}
	for _, v := range next {
		retained[v.ID] = true
	}
	for _, v := range old {
		if !retained[v.ID] {
			_ = os.Remove(filepath.Join(h.dir, v.ID+".clip"))
		}
	}
	return nil
}
func (h *history) watch() {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		c, seq, err := readClipboard(h.sequence)
		h.sequence = seq
		if err == nil && len(c.Data) > 0 {
			err = h.capture(c)
		}
		h.mu.Lock()
		if err != nil {
			h.status = clipboardStatus(err)
		} else {
			h.status = ""
		}
		h.mu.Unlock()
	}
}
func result(value any) (protocol.CommandResult, error) {
	data, err := json.Marshal(value)
	return protocol.CommandResult{Text: string(data)}, err
}
func (h *history) command(ctx context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch p.CommandID {
	case "list":
		query := strings.ToLower(strings.TrimSpace(p.Input))
		rows := []item{}
		for _, v := range h.items {
			matched := query == "" || strings.Contains(strings.ToLower(v.Text), query) || v.Kind == "image" && strings.Contains("图片 image", query)
			if !matched && v.Kind == "text" {
				if data, err := h.read(v); err == nil {
					matched = strings.Contains(strings.ToLower(string(data.Data)), query)
				}
			}
			if matched {
				rows = append(rows, v)
			}
		}
		return result(map[string]any{"items": rows, "status": h.status})
	case "preview", "select", "delete":
		index := -1
		for i, v := range h.items {
			if v.ID == p.Input {
				index = i
				break
			}
		}
		if index < 0 {
			return result(map[string]string{"error": "条目已失效，请刷新"})
		}
		v := h.items[index]
		if p.CommandID == "delete" {
			old := append([]item(nil), h.items...)
			h.items = append(h.items[:index:index], h.items[index+1:]...)
			if h.save() != nil {
				h.items = old
				return result(map[string]string{"error": "删除失败"})
			}
			_ = os.Remove(filepath.Join(h.dir, v.ID+".clip"))
			return result(nil)
		}
		c, err := h.read(v)
		if err != nil {
			return result(map[string]string{"error": "无法读取条目"})
		}
		if p.CommandID == "preview" {
			if c.Kind != "image" {
				r := []rune(string(c.Data))
				truncated := len(r) > 16000
				if truncated {
					r = r[:16000]
				}
				return result(map[string]any{"text": string(r), "truncated": truncated})
			}
			img, err := png.Decode(bytes.NewReader(c.Data))
			if err != nil {
				return result(nil)
			}
			bounds := img.Bounds()
			w := min(bounds.Dx(), 160)
			height := max(1, bounds.Dy()*w/bounds.Dx())
			if height > 120 {
				height = 120
				w = max(1, bounds.Dx()*height/bounds.Dy())
			}
			thumb := image.NewNRGBA(image.Rect(0, 0, w, height))
			for y := 0; y < height; y++ {
				for x := 0; x < w; x++ {
					thumb.Set(x, y, img.At(bounds.Min.X+x*bounds.Dx()/w, bounds.Min.Y+y*bounds.Dy()/height))
				}
			}
			return result(map[string]any{"width": w, "height": height, "pixels": thumb.Pix})
		}
		if err = writeClipboard(c); err != nil {
			return result(map[string]string{"error": "无法写入系统剪贴板"})
		}
		h.last = v.ID
		return result(nil)
	case "clear":
		old := h.items
		h.items = []item{}
		if h.save() != nil {
			h.items = old
			return result(map[string]string{"error": "清空失败"})
		}
		for _, v := range old {
			_ = os.Remove(filepath.Join(h.dir, v.ID+".clip"))
		}
		return result(nil)
	}
	return protocol.CommandResult{}, errors.New("未知命令")
}
func main() {
	h := &history{}
	_ = sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.clipboard", sdk.Handlers{Initialize: func(p protocol.InitializeParams) error {
		if err := h.load(p.DataDir); err != nil {
			return err
		}
		go h.watch()
		return nil
	}, Command: h.command})
}
