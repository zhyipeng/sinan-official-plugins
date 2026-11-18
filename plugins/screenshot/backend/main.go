package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image/png"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
)

const maxImage = 8 << 20
const chunkSize = 36 << 10

type snapshot struct {
	Action captureAction `json:"action,omitempty"`
	ID     string        `json:"id,omitempty"`
	State  string        `json:"state,omitempty"`
	Error  string        `json:"error,omitempty"`
	Size   int           `json:"size,omitempty"`
	Data   string        `json:"data,omitempty"`
	Path   string        `json:"path,omitempty"`
}
type service struct {
	closed   bool
	workers  sync.WaitGroup
	mu       sync.Mutex
	job      snapshot
	image    []byte
	upload   []byte
	uploadID string
	touched  time.Time
	cancel   context.CancelFunc
	capture  func(context.Context, bool) (captureResult, error)
	write    func(context.Context, []byte) error
}

func identifier() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("无法生成任务标识")
	}
	return hex.EncodeToString(b[:])
}
func validateImage(data []byte) error {
	if len(data) == 0 || len(data) > maxImage {
		return errors.New("PNG 图片超过 8 MiB 限制或内容为空")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 32_000_000 {
		return errors.New("PNG 图片无效或超过 3200 万像素")
	}
	// Validate the compressed stream before handing it to the clipboard or saving it.
	_, err = png.Decode(bytes.NewReader(data))
	if err != nil {
		return errors.New("PNG 图片数据损坏")
	}
	return nil
}
func (s *service) start(allowOCR bool) (snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return snapshot{}, errors.New("插件正在退出")
	}
	if s.job.State == "running" {
		return snapshot{}, errors.New("已有截图正在进行")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	s.cancel = cancel
	s.image = nil
	s.upload = nil
	s.uploadID = ""
	s.touched = time.Now()
	id := identifier()
	s.job = snapshot{ID: id, State: "running"}
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		defer cancel()
		result, err := s.capture(ctx, allowOCR)
		if err == nil && result.action != captureCompleted {
			err = validateImage(result.data)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.job.ID != id || s.job.State != "running" {
			return
		}
		if err != nil {
			s.job.State = "failed"
			s.job.Error = err.Error()
			return
		}
		s.image = result.data
		s.job.State = "done"
		s.job.Size = len(result.data)
		s.job.Action = result.action
	}()
	return s.job, nil
}
func (s *service) clear() {
	if s.cancel != nil {
		s.cancel()
	}
	s.job = snapshot{}
	s.image = nil
	s.upload = nil
	s.uploadID = ""
}
func (s *service) maintain(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			s.closed = true
			s.clear()
			s.mu.Unlock()
			return
		case <-ticker.C:
			s.mu.Lock()
			if !s.touched.IsZero() && time.Since(s.touched) > 15*time.Second {
				s.clear()
			}
			s.mu.Unlock()
		}
	}
}
func (s *service) command(ctx context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
	v, err := s.execute(ctx, p)
	if err != nil {
		v = snapshot{State: "failed", Error: err.Error()}
	}
	data, err := json.Marshal(v)
	return protocol.CommandResult{Text: string(data), Dismiss: p.CommandID == "capture-region" && (v.State != "done" || v.Size <= 0), KeepHidden: p.CommandID == "capture-region" && v.State == "done" && v.Size > 0}, err
}
func (s *service) execute(ctx context.Context, p protocol.CommandParams) (snapshot, error) {
	if err := ctx.Err(); err != nil {
		return snapshot{}, err
	}
	if p.CommandID == "capture-region" {
		if p.Input != "" && p.Input != "ocr" {
			return snapshot{}, errors.New("不支持的截图选项")
		}
		return s.captureForView(ctx, p.Input == "ocr")
	}
	if p.CommandID == "start" {
		if p.Input != "" {
			return snapshot{}, errors.New("截图不接受外部参数")
		}
		return s.start(false)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return snapshot{}, errors.New("插件正在退出")
	}
	s.touched = time.Now()
	switch p.CommandID {
	case "poll":
		if p.Input != s.job.ID || p.Input == "" {
			return snapshot{}, errors.New("截图任务已过期")
		}
		return s.job, nil
	case "cancel":
		if p.Input == s.job.ID && p.Input != "" {
			s.clear()
		}
		return snapshot{State: "cancelled"}, nil
	case "read":
		parts := strings.Split(p.Input, ":")
		if len(parts) != 2 || parts[0] != s.job.ID || s.job.State != "done" {
			return snapshot{}, errors.New("截图任务已过期")
		}
		offset, err := strconv.Atoi(parts[1])
		if err != nil || offset < 0 || offset >= len(s.image) {
			return snapshot{}, errors.New("图片偏移无效")
		}
		end := min(offset+chunkSize, len(s.image))
		return snapshot{Data: base64.StdEncoding.EncodeToString(s.image[offset:end])}, nil
	case "upload-start":
		if p.Input != "" {
			return snapshot{}, errors.New("上传不接受外部参数")
		}
		s.upload = nil
		s.uploadID = identifier()
		return snapshot{ID: s.uploadID}, nil
	case "upload":
		parts := strings.SplitN(p.Input, ":", 3)
		if len(parts) != 3 || parts[0] != s.uploadID || s.uploadID == "" {
			return snapshot{}, errors.New("图片上传已过期")
		}
		offset, err := strconv.Atoi(parts[1])
		if err != nil || offset != len(s.upload) {
			return snapshot{}, errors.New("图片分块顺序无效")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(parts[2])
		if err != nil || len(data) == 0 || len(data) > chunkSize || len(s.upload)+len(data) > maxImage {
			return snapshot{}, errors.New("图片分块无效或超过 8 MiB")
		}
		s.upload = append(s.upload, data...)
		return snapshot{Size: len(s.upload)}, nil
	case "save":
		parts := strings.Split(p.Input, ":")
		if len(parts) != 2 || parts[0] == "" || parts[0] != s.uploadID {
			return snapshot{}, errors.New("图片上传已过期")
		}
		if err := validateImage(s.upload); err != nil {
			return snapshot{}, err
		}
		offset, err := strconv.Atoi(parts[1])
		if err != nil || offset < 0 || offset >= len(s.upload) {
			return snapshot{}, errors.New("图片偏移无效")
		}
		return snapshot{Size: len(s.upload), Data: base64.StdEncoding.EncodeToString(s.upload[offset:min(offset+chunkSize, len(s.upload))])}, nil
	case "copy":
		if p.Input == "" || p.Input != s.uploadID {
			return snapshot{}, errors.New("图片上传已过期")
		}
		if err := validateImage(s.upload); err != nil {
			return snapshot{}, err
		}
		if err := s.write(ctx, s.upload); err != nil {
			return snapshot{}, errors.New("复制失败，请检查宿主剪贴板权限与系统服务")
		}
		s.upload = nil
		s.uploadID = ""
		return snapshot{State: "done"}, nil
	}
	return snapshot{}, errors.New("不支持的命令")
}
func main() {
	var host *sdk.HostClient
	s := &service{capture: captureRegion, write: func(ctx context.Context, data []byte) error {
		return host.ClipboardWrite(ctx, protocol.ClipboardContent{Kind: "image", Data: data})
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.maintain(ctx); close(done) }()
	err := sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.screenshot", sdk.Handlers{
		HostReady: func(h *sdk.HostClient) { host = h },
		Initialize: func(p protocol.InitializeParams) error {
			if !slices.Contains(p.HostCapabilities, protocol.ClipboardCapability) || !slices.Contains(p.HostCapabilities, protocol.WindowExecuteCapability) || !slices.Contains(p.HostCapabilities, protocol.ImageOutputCapability) || !slices.Contains(p.HostCapabilities, protocol.ImageInputCapability) || !slices.Contains(p.HostCapabilities, protocol.PluginHandoffCapability) {
				return errors.New("请使用支持 clipboard.v1、ui.window-execute.v1 、ui.image-output.v1 、ui.image-input.v1 和 ui.plugin-handoff.v1 的配套宿主（已发布 0.3.1 不支持）")
			}
			return nil
		}, Command: s.command})
	cancel()
	<-done
	s.workers.Wait()
	if err != nil {
		os.Exit(1)
	}
}

// The host owns hiding and restoration; keep the private task lease alive while
// waiting on a cancellable stdio command, without polling the hidden WebView.
func (s *service) captureForView(ctx context.Context, allowOCR bool) (snapshot, error) {
	first, err := s.start(allowOCR)
	if err != nil {
		return snapshot{}, err
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		if s.job.ID != first.ID {
			s.mu.Unlock()
			return snapshot{}, errors.New("截图任务已取消或过期")
		}
		value := s.job
		s.touched = time.Now()
		s.mu.Unlock()
		if value.State != "running" {
			return value, nil
		}
		select {
		case <-ctx.Done():
			s.mu.Lock()
			if s.job.ID == first.ID {
				s.clear()
			}
			s.mu.Unlock()
			return snapshot{}, ctx.Err()
		case <-ticker.C:
		}
	}
}
