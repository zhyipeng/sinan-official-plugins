package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"sinan-ocr/internal/workerio"
	protocol "sinan/packages/plugin-protocol"
)

func imageFixture() []byte {
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	return b.Bytes()
}

func waitTask(t *testing.T, s *service, id string) snapshot {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		value := s.poll(id)
		if value.State != "running" {
			return value
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("task did not complete")
	return snapshot{}
}

func TestAsyncTaskSingleWorkerAndCancellation(t *testing.T) {
	entered := make(chan struct{})
	s := newService(func(context.Context) ([]byte, error) { return imageFixture(), nil },
		func(ctx context.Context, _ []byte) (string, error) {
			close(entered)
			<-ctx.Done()
			return "late result", nil
		})
	defer s.close()
	started := s.start()
	if started.State != "running" || len(started.ID) != 32 {
		t.Fatal("start did not return bounded task handle")
	}
	<-entered
	if s.start().State != "failed" {
		t.Fatal("concurrent worker admitted")
	}
	s.cancel(started.ID)
	s.wg.Wait()
	if value := s.poll(started.ID); value.State != "cancelled" || value.Text != "" {
		t.Fatal("late result replaced cancellation")
	}
}

func TestLeaseExpirationCancelsAndResultIsBounded(t *testing.T) {
	var tick atomic.Int64
	entered, cancelled := make(chan struct{}), make(chan struct{})
	s := newService(func(context.Context) ([]byte, error) { return imageFixture(), nil },
		func(ctx context.Context, _ []byte) (string, error) {
			close(entered)
			<-ctx.Done()
			close(cancelled)
			return "", ctx.Err()
		})
	s.now = func() time.Time { return time.Unix(tick.Load(), 0) }
	defer s.close()
	job := s.start()
	<-entered
	tick.Store(6)
	s.mu.Lock()
	s.sweepLocked()
	s.mu.Unlock()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("abandoned view kept worker alive")
	}
	if s.poll(job.ID).State != "cancelled" {
		t.Fatal("expired task accepted")
	}
	s.wg.Wait()
	tick.Store(100)
	if value := s.poll(job.ID); value.ID != "" {
		t.Fatal("expired text retained")
	}
}

func TestTimeoutInvalidImageAndOversizedText(t *testing.T) {
	for _, name := range []string{"timeout", "invalid", "text"} {
		t.Run(name, func(t *testing.T) {
			s := newService(func(context.Context) ([]byte, error) {
				if name == "invalid" {
					return []byte("not PNG"), nil
				}
				return imageFixture(), nil
			}, func(ctx context.Context, _ []byte) (string, error) {
				if name == "timeout" {
					<-ctx.Done()
					return "", errors.New("worker ended")
				}
				return strings.Repeat("x", workerio.MaxText+1), nil
			})
			s.budget = 20 * time.Millisecond
			defer s.close()
			if value := waitTask(t, s, s.start().ID); value.State != "failed" || value.Error == "" || value.Text != "" {
				t.Fatal("invalid task did not fail safely")
			}
		})
	}
}

func TestFinishedJobsAndCommandInput(t *testing.T) {
	s := newService(func(context.Context) ([]byte, error) { return imageFixture(), nil }, func(context.Context, []byte) (string, error) { return "中文 result", nil })
	defer s.close()
	for i := 0; i < 8; i++ {
		result := waitTask(t, s, s.start().ID)
		if result.State != "done" || result.Text != "中文 result" {
			t.Fatal("lost result")
		}
	}
	if len(s.jobs) > 4 {
		t.Fatal("unbounded result retention")
	}
	if _, err := s.command(context.Background(), protocol.CommandParams{CommandID: "start", Input: "/private/image.png"}); err == nil {
		t.Fatal("arbitrary path accepted")
	}
	result, err := s.command(context.Background(), protocol.CommandParams{CommandID: "start"})
	var response snapshot
	if err != nil || json.Unmarshal([]byte(result.Text), &response) != nil || response.ID == "" {
		t.Fatal("command did not return task")
	}
}

func TestImageSnapshotDoesNotReadClipboard(t *testing.T) {
	data := imageFixture()
	s := newService(func(context.Context) ([]byte, error) { t.Error("unexpected clipboard read"); return nil, nil }, func(_ context.Context, image []byte) (string, error) {
		if !bytes.Equal(image, data) {
			t.Error("image changed")
		}
		return "snapshot", nil
	})
	defer s.close()
	job := s.startImage(data)
	for i := 0; i < 100; i++ {
		result := s.poll(job.ID)
		if result.State == "done" {
			if result.Text != "snapshot" {
				t.Fatal(result)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("image job did not complete")
}
