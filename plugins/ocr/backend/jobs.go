package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image/png"
	"sync"
	"time"

	"sinan-ocr/internal/workerio"
)

type snapshot struct {
	ID    string `json:"id,omitempty"`
	State string `json:"state"`
	Text  string `json:"text,omitempty"`
	Error string `json:"error,omitempty"`
}

type task struct {
	snapshot
	lease, expires time.Time
	cancel         context.CancelFunc
}

type service struct {
	mu     sync.Mutex
	jobs   map[string]*task
	active *task
	ctx    context.Context
	stop   context.CancelFunc
	wg     sync.WaitGroup
	read   func(context.Context) ([]byte, error)
	run    func(context.Context, []byte) (string, error)
	now    func() time.Time
	lease  time.Duration
	budget time.Duration
	closed bool
}

func newService(read func(context.Context) ([]byte, error), run func(context.Context, []byte) (string, error)) *service {
	ctx, stop := context.WithCancel(context.Background())
	return &service{jobs: map[string]*task{}, ctx: ctx, stop: stop, read: read, run: run,
		now: time.Now, lease: 5 * time.Second, budget: 30 * time.Second}
}

func (s *service) start() snapshot { return s.startImage(nil) }

func (s *service) startImage(image []byte) snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return snapshot{State: "failed", Error: "插件正在关闭"}
	}
	s.sweepLocked()
	if s.active != nil {
		return snapshot{State: "failed", Error: "上一个识别任务尚未结束，请稍后重试"}
	}
	if len(s.jobs) >= 4 {
		var oldest *task
		for _, job := range s.jobs {
			if oldest == nil || job.expires.Before(oldest.expires) {
				oldest = job
			}
		}
		delete(s.jobs, oldest.ID)
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return snapshot{State: "failed", Error: "无法创建识别任务"}
	}
	ctx, cancel := context.WithTimeout(s.ctx, s.budget)
	job := &task{snapshot: snapshot{ID: hex.EncodeToString(random[:]), State: "running"},
		lease: s.now().Add(s.lease), cancel: cancel}
	s.jobs[job.ID], s.active = job, job
	s.wg.Add(1)
	go s.recognize(ctx, job, bytes.Clone(image))
	return job.snapshot
}

func (s *service) recognize(ctx context.Context, job *task, data []byte) {
	defer s.wg.Done()
	defer job.cancel()
	var err error
	if len(data) == 0 {
		data, err = s.read(ctx)
	}
	if err == nil {
		var cfgErr error
		if len(data) == 0 || len(data) > workerio.MaxPNG {
			cfgErr = errors.New("图片超过 8 MiB 限制")
		} else {
			cfg, e := png.DecodeConfig(bytes.NewReader(data))
			if e != nil {
				cfgErr = errors.New("剪贴板图片不是有效 PNG")
			} else if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > workerio.MaxPixels/cfg.Height {
				cfgErr = errors.New("图片超过 1600 万像素限制")
			}
		}
		err = cfgErr
	}
	text := ""
	if err == nil {
		text, err = s.run(ctx, data)
	}
	if err == nil && !workerio.ValidText(text) {
		err = errors.New("识别结果超过 32 KiB 或包含无效字符")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = nil
	if job.State == "running" {
		switch {
		case ctx.Err() == context.DeadlineExceeded:
			job.State, job.Error = "failed", "识别超时，请缩小图片后重试"
		case ctx.Err() != nil:
			job.State = "cancelled"
		case err != nil:
			job.State, job.Error = "failed", err.Error()
		default:
			job.State, job.Text = "done", text
		}
		job.expires = s.now().Add(time.Minute)
	}
}

func (s *service) poll(id string) snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	job := s.jobs[id]
	if job == nil {
		return snapshot{State: "failed", Error: "任务已过期，请重新识别"}
	}
	if job.State == "running" {
		job.lease = s.now().Add(s.lease)
	}
	return job.snapshot
}

func (s *service) cancel(id string) snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if job := s.jobs[id]; job != nil {
		if job.State == "running" {
			job.cancel()
		}
		job.State, job.Text, job.Error = "cancelled", "", ""
		job.expires = s.now().Add(time.Minute)
		return job.snapshot
	}
	return snapshot{State: "cancelled"}
}

func (s *service) sweepLocked() {
	now := s.now()
	for id, job := range s.jobs {
		if job.State == "running" && !now.Before(job.lease) {
			job.State, job.Error = "cancelled", "页面已离开或暂停，任务已取消"
			job.expires = now.Add(time.Minute)
			job.cancel()
		} else if job.State != "running" && !now.Before(job.expires) {
			delete(s.jobs, id)
		}
	}
}

func (s *service) maintain() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			s.sweepLocked()
			s.mu.Unlock()
		}
	}
}

func (s *service) close() {
	s.mu.Lock()
	s.closed = true
	s.stop()
	s.mu.Unlock()
	s.wg.Wait()
	s.mu.Lock()
	s.jobs = map[string]*task{}
	s.mu.Unlock()
}
