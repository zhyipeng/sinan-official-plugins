package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	protocol "sinan/packages/plugin-protocol"
	"testing"
	"time"
)

func fixture(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 12, 8))
	img.Set(3, 4, color.NRGBA{255, 0, 0, 255})
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func call(t *testing.T, s *service, id, input string) snapshot {
	t.Helper()
	v, err := s.execute(context.Background(), protocol.CommandParams{CommandID: id, Input: input})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestCaptureLifecycle(t *testing.T) {
	data := fixture(t)
	s := &service{capture: func(context.Context, bool) (captureResult, error) { return captureResult{data: data}, nil }}
	first := call(t, s, "start", "")
	var result snapshot
	for i := 0; i < 100; i++ {
		result = call(t, s, "poll", first.ID)
		if result.State != "running" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if result.State != "done" || result.Size != len(data) {
		t.Fatal(result)
	}
	chunk := call(t, s, "read", first.ID+":0")
	got, err := base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("图片传输不一致")
	}
	call(t, s, "cancel", first.ID)
	if _, err = s.execute(context.Background(), protocol.CommandParams{CommandID: "read", Input: first.ID + ":0"}); err == nil {
		t.Fatal("已撤销图片仍可读取")
	}
}
func TestCancelAndShutdownKillCapture(t *testing.T) {
	stopped := make(chan struct{})
	s := &service{capture: func(ctx context.Context, _ bool) (captureResult, error) {
		<-ctx.Done()
		close(stopped)
		return captureResult{}, ctx.Err()
	}}
	first := call(t, s, "start", "")
	if _, err := s.start(false); err == nil {
		t.Fatal("允许并发截图")
	}
	// Wrong task IDs cannot cancel another capture.
	call(t, s, "cancel", "wrong")
	if call(t, s, "poll", first.ID).State != "running" {
		t.Fatal("错误任务取消了截图")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.maintain(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("退出未清理")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("截图未取消")
	}
}
func TestUploadCopyAndSave(t *testing.T) {
	data := fixture(t)
	var written []byte
	s := &service{write: func(_ context.Context, b []byte) error { written = bytes.Clone(b); return nil }}
	upload := func() string {
		id := call(t, s, "upload-start", "").ID
		call(t, s, "upload", id+":0:"+base64.StdEncoding.EncodeToString(data))
		return id
	}
	id := upload()
	call(t, s, "copy", id)
	if !bytes.Equal(data, written) {
		t.Fatal("复制图片不同")
	}
	if _, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "save", Input: id + ":0"}); err == nil {
		t.Fatal("上传标识可重放")
	}
	id = upload()
	result := call(t, s, "save", id+":0")
	got, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil || !bytes.Equal(got, data) || result.Size != len(data) {
		t.Fatal("PNG export changed data")
	}
	// Native dialog cancellation can retry the same upload; no path is returned.
	again := call(t, s, "save", id+":0")
	if again.Data != result.Data || again.Path != "" {
		t.Fatal("export must be read-only and retryable")
	}

}
func TestRejectInvalidAndOutOfOrderUploads(t *testing.T) {
	s := &service{}
	id := call(t, s, "upload-start", "").ID
	for _, input := range []string{id + ":1:YWJj", id + ":0:!", "wrong:0:YWJj", id + ":0:" + base64.StdEncoding.EncodeToString(make([]byte, chunkSize+1))} {
		if _, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "upload", Input: input}); err == nil {
			t.Fatal("接受非法块")
		}
	}
	call(t, s, "upload", id+":0:YWJj")
	if _, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "save", Input: id + ":0"}); err == nil {
		t.Fatal("保存了非法 PNG")
	}
	for _, data := range [][]byte{nil, []byte("not png"), make([]byte, maxImage+1)} {
		if validateImage(data) == nil {
			t.Fatal("接受非法图片")
		}
	}
	data := fixture(t)
	if validateImage(data[:len(data)-8]) == nil {
		t.Fatal("接受截断 PNG")
	}
}
func TestCaptureFailureAndWriteFailure(t *testing.T) {
	s := &service{capture: func(context.Context, bool) (captureResult, error) { return captureResult{}, errors.New("模拟拒绝") }, write: func(context.Context, []byte) error { return errors.New("模拟失败") }}
	id := call(t, s, "start", "").ID
	for i := 0; i < 100; i++ {
		v := call(t, s, "poll", id)
		if v.State == "failed" {
			if v.Error != "模拟拒绝" {
				t.Fatal(v)
			}
			break
		}
		if i == 99 {
			t.Fatal("失败未上报")
		}
		time.Sleep(time.Millisecond)
	}
	upload := call(t, s, "upload-start", "").ID
	call(t, s, "upload", upload+":0:"+base64.StdEncoding.EncodeToString(fixture(t)))
	if _, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "copy", Input: upload}); err == nil {
		t.Fatal("复制失败被吞掉")
	}
	if len(s.upload) == 0 {
		t.Fatal("复制失败丢失重试数据")
	}
}
func TestNoExternalPaths(t *testing.T) {
	s := &service{}
	if _, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "start", Input: "/external/path"}); err == nil {
		t.Fatal("接受外部路径")
	}
	if _, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "save", Input: "/external/path:0"}); err == nil {
		t.Fatal("接受外部保存路径")
	}

}

func TestCommandReportsActionableErrors(t *testing.T) {
	s := &service{}
	result, err := s.command(context.Background(), protocol.CommandParams{CommandID: "read", Input: "expired:0"})
	if err != nil {
		t.Fatal(err)
	}
	var value snapshot
	if json.Unmarshal([]byte(result.Text), &value) != nil || value.Error != "截图任务已过期" {
		t.Fatal("错误被 SDK 通用 handler failed 吞掉", result)
	}
	s.closed = true
	if _, err = s.start(false); err == nil {
		t.Fatal("退出后仍能启动截图")
	}
}

func TestHiddenCaptureReturnsCompletedTaskWithoutPagePolling(t *testing.T) {
	data := fixture(t)
	s := &service{capture: func(context.Context, bool) (captureResult, error) { return captureResult{data: data}, nil }}
	value, err := s.execute(context.Background(), protocol.CommandParams{CommandID: "capture-region"})
	if err != nil || value.State != "done" || value.Size != len(data) || value.ID == "" {
		t.Fatal("hidden capture did not complete", value, err)
	}
	if got := call(t, s, "read", value.ID+":0"); got.Data != base64.StdEncoding.EncodeToString(data) {
		t.Fatal("completed capture unavailable")
	}
}
func TestHiddenCaptureCancellationStopsNativeTask(t *testing.T) {
	stopped := make(chan struct{})
	s := &service{capture: func(ctx context.Context, _ bool) (captureResult, error) {
		<-ctx.Done()
		close(stopped)
		return captureResult{}, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.captureForView(ctx, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("native task survived cancellation")
	}
	s.workers.Wait()
}

func TestCaptureWithoutValidImageDismissesPostProcessing(t *testing.T) {
	for _, kind := range []string{"cancelled", "missing", "empty", "invalid", "image"} {
		t.Run(kind, func(t *testing.T) {
			s := &service{capture: func(context.Context, bool) (captureResult, error) {
				switch kind {
				case "cancelled", "missing":
					return captureResult{}, errors.New("未生成图片")
				case "empty":
					return captureResult{}, nil
				case "invalid":
					return captureResult{data: []byte("not png")}, nil
				default:
					return captureResult{data: fixture(t)}, nil
				}
			}}
			result, err := s.command(context.Background(), protocol.CommandParams{CommandID: "capture-region"})
			if err != nil {
				t.Fatal(err)
			}
			s.workers.Wait()
			if result.Dismiss != (kind != "image") || result.KeepHidden != (kind == "image") {
				t.Fatal("wrong post-processing presentation", kind, result.Dismiss)
			}
			var value snapshot
			if json.Unmarshal([]byte(result.Text), &value) != nil {
				t.Fatal("invalid result")
			}
			if kind == "image" && (value.State != "done" || value.Size == 0) {
				t.Fatal("valid image lost")
			}
		})
	}
}

func TestCaptureOverlayRoutesCompletionAndOCR(t *testing.T) {
	for _, action := range []captureAction{captureCompleted, captureOCR} {
		t.Run(string(action), func(t *testing.T) {
			result := captureResult{action: action}
			if action == captureOCR {
				result.data = fixture(t)
			}
			s := &service{capture: func(_ context.Context, allowed bool) (captureResult, error) {
				if !allowed {
					return captureResult{}, errors.New("缺少 OCR 选项")
				}
				return result, nil
			}}
			value, err := s.command(context.Background(), protocol.CommandParams{CommandID: "capture-region", Input: "ocr"})
			if err != nil {
				t.Fatal(err)
			}
			s.workers.Wait()
			var got snapshot
			if err = json.Unmarshal([]byte(value.Text), &got); err != nil {
				t.Fatal(err)
			}
			if got.State != "done" || got.Action != action || got.Size != len(result.data) ||
				value.Dismiss != (action == captureCompleted) || value.KeepHidden != (action == captureOCR) {
				t.Fatalf("截图输出错误：%+v，%+v", got, value)
			}
		})
	}
}
