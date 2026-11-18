package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"time"
)

type runState string

const (
	running   runState = "running"
	completed runState = "completed"
	failed    runState = "failed"
)

type scriptRun struct {
	result runResult
	output *outputCapture
}

type runResult struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Status      runState `json:"status"`
	ShowOutput  bool     `json:"showOutput"`
	Output      string   `json:"output,omitempty"`
	Path        string   `json:"path,omitempty"`
	Detail      string   `json:"detail,omitempty"`
	Delivery    string   `json:"delivery,omitempty"`
	PreviewOnly bool     `json:"previewOnly,omitempty"`
	Incomplete  bool     `json:"incomplete,omitempty"`
}

var errEnvironment = errors.New("找不到匹配的环境，请在脚本设置中选择解释器")

func (p *plugin) start(ctx context.Context, id, source string) (runResult, error) {
	if len(id) != 64 {
		return runResult{}, errors.New("脚本标识无效")
	}
	index, revision, err := p.index(ctx)
	if err != nil {
		return runResult{}, err
	}
	pos := slices.IndexFunc(index.scripts, func(s script) bool { return s.ID == id })
	if pos < 0 {
		return runResult{}, errors.New("脚本已失效，请刷新列表")
	}
	item := index.scripts[pos]
	auto := discover()

	p.mu.Lock()
	defer p.mu.Unlock()
	if revision != p.revision || (source != "library" && (item.HideFromSearch || item.ShowOutput != (source == "output"))) {
		return runResult{}, errors.New("脚本设置已变化，请刷新后重试")
	}
	if err := ctx.Err(); err != nil {
		return runResult{}, err
	}
	if current := p.runs[id]; current != nil && current.result.Status == running {
		return runResult{}, errors.New("此脚本正在运行")
	}
	active := 0
	for _, run := range p.jobs {
		if run.result.Status == running || run.result.Delivery == "pending" {
			active++
		}
	}
	if active >= 16 {
		return runResult{}, errors.New("同时运行或通知的脚本已达上限")
	}
	if p.jobs == nil {
		p.jobs = make(map[string]*scriptRun)
	}
	if len(p.jobs) >= 128 {
		for key, old := range p.jobs {
			if old.result.Status != running && old.result.Delivery != "pending" {
				delete(p.jobs, key)
				if p.runs[old.result.scriptID()] == old {
					delete(p.runs, old.result.scriptID())
				}
				break
			}
		}
	}
	job := &scriptRun{
		result: runResult{ID: id + ":" + rand.Text(), Name: item.Name, Status: running, ShowOutput: item.ShowOutput},
		output: newOutputCapture(),
	}
	p.runs[id], p.jobs[job.result.ID] = job, job

	cmd, err := p.startCommand(ctx, item, auto, job.output)
	if err != nil {
		job.result.Status, job.result.Detail = failed, err.Error()
		if !item.ShowOutput {
			job.result.Delivery = "pending"
		}
		initial := job.result
		go p.finish(job, nil)
		return initial, nil
	}
	go p.finish(job, cmd)
	return job.result, nil
}

func (result runResult) scriptID() string { return result.ID[:64] }

func (p *plugin) startCommand(ctx context.Context, item script, auto []environment, capture *outputCapture) (*exec.Cmd, error) {
	stat := os.Lstat
	if item.Imported {
		stat = os.Stat
	}
	info, err := stat(item.Path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("脚本文件不存在或不可访问")
	}
	env, err := interpreter(item, append(auto, p.cfg.Environments...))
	if err != nil {
		return nil, err
	}
	if !executable(env.Path) {
		return nil, errors.New("所选解释器或脚本无法直接执行")
	}
	var args []string
	if env.ID != direct {
		args = []string{item.Path}
	}
	cmd := exec.Command(env.Path, args...)
	cmd.Dir = filepath.Dir(item.Path)
	cmd.Stdout, cmd.Stderr = capture, capture
	cmd.WaitDelay = 2 * time.Second
	background(cmd)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cmd.Start() != nil {
		return nil, errors.New("无法启动脚本，请检查文件权限和解释器")
	}
	return cmd, nil
}

func exitCode(cmd *exec.Cmd) int {
	if cmd.ProcessState == nil {
		return -1
	}
	return cmd.ProcessState.ExitCode()
}

func (p *plugin) finish(job *scriptRun, cmd *exec.Cmd) {
	if cmd != nil {
		wait := cmd.Wait()
		job.output.finish()
		p.mu.Lock()
		job.result.Status = completed
		if cmd.ProcessState == nil || !cmd.ProcessState.Success() {
			job.result.Status = failed
			job.result.Detail = "脚本异常退出"
			if code := exitCode(cmd); code >= 0 {
				job.result.Detail = fmt.Sprintf("退出码 %d", code)
			}
		}
		if errors.Is(wait, exec.ErrWaitDelay) {
			job.output.mu.Lock()
			job.output.incomplete = true
			job.output.mu.Unlock()
		}
		if !job.result.ShowOutput {
			job.result.Delivery = "pending"
		}
		p.mu.Unlock()
	} else {
		job.output.finish()
	}
	snapshot, size := p.snapshotRun(job)
	if snapshot.ShowOutput {
		if size <= outputPreviewLimit && !snapshot.Incomplete {
			job.output.remove()
		}
		return
	}
	message, long := resultNotification(snapshot, size)
	state := "sent"
	p.notifyMu.Lock()
	if p.notify == nil || p.notify(context.Background(), message) != nil {
		state = "unavailable"
	}
	p.notifyMu.Unlock()
	if state == "sent" && !long {
		job.output.remove()
	}
	p.mu.Lock()
	job.result.Delivery = state
	p.mu.Unlock()
}

func (p *plugin) snapshotRun(job *scriptRun) (runResult, int) {
	p.mu.RLock()
	result := job.result
	p.mu.RUnlock()
	var size int
	result.Output, size, result.Path, result.Incomplete = job.output.view()
	result.PreviewOnly = size > outputPreviewLimit
	if result.Status == running || (result.ShowOutput && size <= outputPreviewLimit && !result.Incomplete) {
		result.Path = ""
	}
	return result, size
}

func (p *plugin) runStatus(id string) (runResult, error) {
	p.mu.RLock()
	job := p.jobs[id]
	p.mu.RUnlock()
	if job == nil {
		return runResult{}, errors.New("此运行记录已失效")
	}
	result, _ := p.snapshotRun(job)
	return result, nil
}
