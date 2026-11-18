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
}

type service struct {
	closed  bool
	mu      sync.Mutex
	workers sync.WaitGroup
	cancel  context.CancelFunc
	expiry  *time.Timer
	jobID   string
	image   []byte
	capture func(context.Context, bool) (captureResult, error)
	write   func(context.Context, []byte) error
}

func identifier() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("无法生成截图任务标识")
	}
	return hex.EncodeToString(value[:])
}

func validateImage(data []byte) error {
	if len(data) == 0 || len(data) > maxImage {
		return errors.New("PNG 图片超过 8 MiB 限制或内容为空")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 32_000_000 {
		return errors.New("PNG 图片无效或超过 3200 万像素")
	}
	if _, err = png.Decode(bytes.NewReader(data)); err != nil {
		return errors.New("PNG 图片数据损坏")
	}
	return nil
}

func (s *service) clearImage() {
	if s.expiry != nil {
		s.expiry.Stop()
		s.expiry = nil
	}
	s.image = nil
	s.jobID = ""
}

func (s *service) captureForView(ctx context.Context, allowOCR bool) (snapshot, error) {
	s.mu.Lock()
	if s.closed || s.cancel != nil {
		s.mu.Unlock()
		return snapshot{}, errors.New("截图任务不可用或已有截图正在进行")
	}
	s.clearImage()
	captureCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	s.cancel = cancel
	s.workers.Add(1)
	s.mu.Unlock()
	defer s.workers.Done()
	defer cancel()

	result, err := s.capture(captureCtx, allowOCR)
	if err == nil && result.action != captureCompleted {
		err = validateImage(result.data)
	}
	if err == nil && result.action == captureLegacyCopy {
		err = s.write(captureCtx, result.data)
		result = captureResult{action: captureCompleted}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.cancel = nil
	if err != nil {
		return snapshot{}, err
	}
	if captureCtx.Err() != nil || s.closed {
		return snapshot{}, errors.New("截图任务已撤销")
	}
	if result.action == captureCompleted {
		return snapshot{State: "done", Action: captureCompleted}, nil
	}
	if result.action != captureOCR || !allowOCR {
		return snapshot{}, errors.New("截图结果无效")
	}
	id := identifier()
	s.jobID, s.image = id, result.data
	s.expiry = time.AfterFunc(2*time.Minute, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.jobID == id {
			s.clearImage()
		}
	})
	return snapshot{ID: id, State: "done", Action: captureOCR, Size: len(result.data)}, nil
}

func (s *service) command(ctx context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
	value, err := s.execute(ctx, p)
	if err != nil {
		value = snapshot{State: "failed", Error: err.Error()}
	}
	data, err := json.Marshal(value)
	handoff := value.State == "done" && value.Action == captureOCR
	hiddenCapture := p.CommandID == "capture-region"
	return protocol.CommandResult{Text: string(data), Dismiss: hiddenCapture && !handoff, KeepHidden: hiddenCapture && handoff}, err
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

	id, offsetText, _ := strings.Cut(p.Input, ":")
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" || id != s.jobID || s.closed {
		return snapshot{}, errors.New("截图已过期")
	}
	switch p.CommandID {
	case "cancel":
		s.clearImage()
		return snapshot{State: "cancelled"}, nil
	case "read":
		offset, err := strconv.Atoi(offsetText)
		if err != nil || offset < 0 || offset >= len(s.image) {
			return snapshot{}, errors.New("图片偏移无效")
		}
		end := min(offset+chunkSize, len(s.image))
		return snapshot{Data: base64.StdEncoding.EncodeToString(s.image[offset:end])}, nil
	case "copy":
		if err := s.write(ctx, s.image); err != nil {
			return snapshot{}, errors.New("复制失败，请重试")
		}
		s.clearImage()
		return snapshot{State: "done"}, nil
	default:
		return snapshot{}, errors.New("不支持的命令")
	}
}

func main() {
	var host *sdk.HostClient
	s := &service{capture: captureRegion, write: func(ctx context.Context, data []byte) error {
		return host.ClipboardWrite(ctx, protocol.ClipboardContent{Kind: "image", Data: data})
	}}
	err := sdk.ServeWithHandlers(os.Stdin, os.Stdout, "tools.screenshot", sdk.Handlers{
		HostReady: func(h *sdk.HostClient) { host = h },
		Initialize: func(p protocol.InitializeParams) error {
			if !slices.Contains(p.HostCapabilities, protocol.ClipboardCapability) ||
				!slices.Contains(p.HostCapabilities, protocol.WindowExecuteCapability) ||
				!slices.Contains(p.HostCapabilities, protocol.PluginHandoffCapability) {
				return errors.New("截图插件需要 Sinan 0.4.0 或更新版本")
			}
			return nil
		}, Command: s.command})

	s.mu.Lock()
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	s.clearImage()
	s.mu.Unlock()
	s.workers.Wait()
	if err != nil {
		os.Exit(1)
	}
}
