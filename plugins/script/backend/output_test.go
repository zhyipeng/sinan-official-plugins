package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	protocol "sinan/packages/plugin-protocol"
)

func TestScriptVisibilityAndOutputRoutePersist(t *testing.T) {
	p := testPlugin(t, t.TempDir())
	dir := t.TempDir()
	put(t, filepath.Join(dir, "report.js"), "fixture")
	apply(t, p, change{Action: "add-directory", Path: dir})
	matches := searchFor(t, p, "report")
	if len(matches) != 1 || matches[0].CommandID != "run" {
		t.Fatal("existing scripts must default to searchable and silent")
	}

	id := matches[0].ID
	on, off := true, false
	apply(t, p, change{Action: "edit", ID: id, HideFromSearch: &on, ShowOutput: &on})
	p = testPlugin(t, p.dir)
	if len(searchFor(t, p, "report")) != 0 {
		t.Fatal("hidden script returned to global search")
	}
	if _, err := p.start(t.Context(), id, "search"); err == nil {
		t.Fatal("a stale search result ran a hidden script")
	}
	value, err := p.list(t.Context(), listRequest{Query: "report"})
	if err != nil || len(value.(map[string]any)["items"].([]script)) != 1 {
		t.Fatal("hidden script disappeared from management")
	}
	apply(t, p, change{Action: "edit", ID: id, HideFromSearch: &off})
	matches = searchFor(t, p, "report")
	if len(matches) != 1 || matches[0].CommandID != "run-view" {
		t.Fatal("visible output route was not preserved")
	}
}

func TestLongOutputAndNotificationBudget(t *testing.T) {
	capture := newOutputCapture()
	defer capture.remove()
	full := strings.Repeat("长", 16384)
	if n, err := capture.Write([]byte(full)); err != nil || n != len(full) {
		t.Fatal("capture returned an error to the child")
	}
	capture.finish()
	preview, size, path, incomplete := capture.view()
	data, err := os.ReadFile(path)
	if incomplete || size != len(full) || err != nil || string(data) != full || len(preview) < outputPreviewLimit-3 {
		t.Fatal("expected the entire output on disk with a bounded preview")
	}
	result := runResult{Name: "脚本", Status: failed, Output: preview, Path: path, Detail: "退出码 3", Incomplete: incomplete}
	params, keep := resultNotification(result, size)
	if !keep || !strings.Contains(params.Title, "执行失败") || !strings.Contains(params.Body, path) ||
		!strings.Contains(params.Body, "退出码 3") || len(params.Body) > protocol.NotificationMaxBodyBytes {
		t.Fatal("oversized output did not yield a bounded log location")
	}
}

func TestSilentAndVisibleResults(t *testing.T) {
	p := testPlugin(t, t.TempDir())
	sent := make(chan protocol.NotificationParams, 2)
	p.notify = func(_ context.Context, params protocol.NotificationParams) error {
		sent <- params
		return nil
	}
	run := func(visible bool) *scriptRun {
		capture := newOutputCapture()
		t.Cleanup(capture.remove)
		_, _ = capture.Write([]byte("stdout fixture\nstderr fixture"))
		job := &scriptRun{output: capture, result: runResult{Name: "sample", Status: completed, ShowOutput: visible}}
		p.finish(job, nil)
		return job
	}
	silent := run(false)
	select {
	case notification := <-sent:
		if !strings.Contains(notification.Title, "执行成功") || notification.Body != "stdout fixture\nstderr fixture" || silent.result.Delivery != "sent" {
			t.Fatal("silent result was not notified")
		}
	case <-time.After(time.Second):
		t.Fatal("missing notification")
	}
	visible := run(true)
	result, _ := p.snapshotRun(visible)
	if !strings.Contains(result.Output, "stderr fixture") || result.Path != "" || len(sent) != 0 {
		t.Fatal("visible run did not preserve output without a notification")
	}
}
