package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"testing"
	"time"

	protocol "sinan/packages/plugin-protocol"
)

func fixture(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 12, 8))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestCaptureOutputs(t *testing.T) {
	data := fixture(t)
	for _, action := range []captureAction{captureCompleted, captureLegacyCopy, captureOCR, ""} {
		t.Run(string(action), func(t *testing.T) {
			copied := 0
			s := &service{
				capture: func(_ context.Context, allowOCR bool) (captureResult, error) {
					if !allowOCR {
						t.Error("OCR 选项未传给原生组件")
					}
					switch action {
					case captureCompleted:
						return captureResult{action: action}, nil
					case captureLegacyCopy, captureOCR:
						return captureResult{action: action, data: data}, nil
					}
					return captureResult{}, errors.New("模拟取消")
				},
				write: func(_ context.Context, image []byte) error {
					if !bytes.Equal(image, data) {
						t.Error("复制的数据有误")
					}
					copied++
					return nil
				},
			}
			result, err := s.command(context.Background(), protocol.CommandParams{CommandID: "capture-region", Input: "ocr"})
			if err != nil {
				t.Fatal(err)
			}
			var value snapshot
			if err := json.Unmarshal([]byte(result.Text), &value); err != nil {
				t.Fatal(err)
			}
			if result.Dismiss != (action != captureOCR) || result.KeepHidden != (action == captureOCR) {
				t.Fatalf("错误的窗口收尾：%+v", result)
			}
			if (copied == 1) != (action == captureLegacyCopy) {
				t.Fatal("旧版 macOS 截图应直接复制")
			}
			if action != captureOCR {
				return
			}
			call := func(command, input string) (snapshot, error) {
				return s.execute(context.Background(), protocol.CommandParams{CommandID: command, Input: input})
			}
			part, err := call("read", value.ID+":0")
			if err != nil || part.Data != base64.StdEncoding.EncodeToString(data) {
				t.Fatal("OCR 分块内容有误", err)
			}
			if _, err = call("copy", value.ID); err != nil || copied != 1 {
				t.Fatal("OCR 恢复复制失败", err)
			}
			if _, err = call("read", value.ID+":0"); err == nil {
				t.Fatal("已消费截图仍可读取")
			}
		})
	}
}

func TestCaptureUsesRequestCancellationAndRejectsConcurrentCapture(t *testing.T) {
	started := make(chan struct{})
	s := &service{capture: func(ctx context.Context, _ bool) (captureResult, error) {
		close(started)
		<-ctx.Done()
		return captureResult{}, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := s.captureForView(ctx, false)
		done <- err
	}()
	<-started
	if _, err := s.captureForView(context.Background(), false); err == nil {
		t.Fatal("并发截图未被拒绝")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("截图未随请求取消")
	}
}
