package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	protocol "sinan/packages/plugin-protocol"
)

func TestMain(m *testing.M) {
	if os.Getenv("SINAN_SCRIPT_TEST_HELPER") == "1" {
		// Verify the literal script argument, its working directory, and direct
		// execution without a platform shell or a real interpreter.
		switch len(os.Args) {
		case 1:
			if err := os.WriteFile("direct-result", []byte("ok"), 0600); err == nil {
				os.Exit(0)
			}
		case 2:
			if body, err := os.ReadFile(os.Args[1]); err == nil && filepath.IsAbs(os.Args[1]) {
				if err = os.WriteFile("script-result", body, 0600); err == nil {
					fmt.Fprint(os.Stdout, "fixture stdout\n")
					fmt.Fprint(os.Stderr, "fixture stderr\n")
					os.Exit(0)
				}
			}
		}
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func testPlugin(t *testing.T, dataDir string) *plugin {
	t.Helper()
	cfg, err := loadConfig(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	return &plugin{dir: dataDir, cfg: cfg, scanning: make(chan struct{}, 1), runs: map[string]*scriptRun{}, notify: func(context.Context, protocol.NotificationParams) error { return nil }}
}

func put(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0700); err != nil {
		t.Fatal(err)
	}
}

func apply(t *testing.T, p *plugin, c change) {
	t.Helper()
	if err := p.change(t.Context(), c); err != nil {
		t.Fatalf("%s: %v", c.Action, err)
	}
}

func searchFor(t *testing.T, p *plugin, query string) []protocol.SearchItem {
	t.Helper()
	res, err := p.search(t.Context(), protocol.SearchParams{ProviderID: "scripts", Query: query, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	return res.Items
}

func TestCatalogConfigurationAndRefresh(t *testing.T) {
	p := testPlugin(t, t.TempDir())
	first, second := t.TempDir(), t.TempDir()
	put(t, filepath.Join(first, "清理.py"), "#!/usr/bin/env python2\n")
	put(t, filepath.Join(second, "report.JS"), "")
	put(t, filepath.Join(second, "backup.sh"), "")
	put(t, filepath.Join(first, "helper.rb"), "fixture")
	apply(t, p, change{Action: "add-directory", Path: first})
	apply(t, p, change{Action: "add-directory", Path: second})
	if a, b := searchFor(t, p, "report"), searchFor(t, p, "backup"); len(a) != 1 || len(b) != 1 || len(searchFor(t, p, "helper")) != 0 {
		t.Fatal("directory scan did not filter script extensions")
	}
	list := searchFor(t, p, "清理")
	if len(list) != 1 || list[0].CommandID != "run" || list[0].Input != list[0].ID {
		t.Fatal("invalid search item")
	}
	id := list[0].ID
	apply(t, p, change{Action: "edit", ID: id, Keywords: []string{" 税务 ", "daily cleanup", "DAILY CLEANUP"}})
	apply(t, p, change{Action: "import", Path: filepath.Join(first, "helper.rb"), Keywords: []string{"其他格式"}})

	p = testPlugin(t, p.dir)
	for _, word := range []string{"税务", "DAILY CLEANUP", "清理.py", "其他格式"} {
		if len(searchFor(t, p, word)) != 1 {
			t.Fatal("persisted keyword or file name did not match")
		}
	}
	cfg := p.cfg
	if len(cfg.Directories) != 2 || len(cfg.Scripts) != 2 {
		t.Fatal("configuration did not survive reinitialization")
	}
	apply(t, p, change{Action: "remove-directory", Path: cfg.Directories[0]})
	if len(searchFor(t, p, "清理")) != 0 || len(searchFor(t, p, "helper")) != 1 {
		t.Fatal("removing a directory affected an explicitly imported file")
	}
	apply(t, p, change{Action: "remove-import", ID: searchFor(t, p, "helper")[0].ID})
	if len(searchFor(t, p, "helper")) != 0 {
		t.Fatal("canceled import remained searchable")
	}
	if _, err := os.Stat(filepath.Join(first, "helper.rb")); err != nil {
		t.Fatal("canceling import changed the file")
	}
	put(t, filepath.Join(second, "new.js"), "")
	if _, err := p.list(t.Context(), listRequest{Refresh: true}); err != nil || len(searchFor(t, p, "new.js")) != 1 {
		t.Fatal("forced refresh did not index file")
	}
}

func TestCreateUsesSelectedDirectoryWithoutOverwriting(t *testing.T) {
	dataDir := t.TempDir()
	p := testPlugin(t, dataDir)
	apply(t, p, change{Action: "add-directory", Path: t.TempDir()})
	dir := p.cfg.Directories[0]
	create := change{Action: "create", Path: dir, Name: "测试 script.py", Text: "fixture", Keywords: []string{"测试创建"}}
	apply(t, p, create)
	if len(searchFor(t, p, "测试创建")) != 1 {
		t.Fatal("created script is absent from search")
	}
	create.Text = "overwrite"
	if err := p.change(t.Context(), create); err == nil {
		t.Fatal("overwrote an existing file")
	}
	path := filepath.Join(dir, create.Name)
	if got, err := os.ReadFile(path); err != nil || string(got) != "fixture" {
		t.Fatal("existing script contents changed")
	}
	create.Name = "../outside.sh"
	if err := p.change(t.Context(), create); err == nil {
		t.Fatal("accepted traversal")
	}
	if err := os.Remove(filepath.Join(dataDir, "scripts.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dataDir, "scripts.json"), 0700); err != nil {
		t.Fatal(err)
	}
	create.Name = "rollback.py"
	if err := p.change(t.Context(), create); err == nil {
		t.Fatal("reported success despite persistence failure")
	}
	if _, err := os.Stat(filepath.Join(dir, create.Name)); !os.IsNotExist(err) {
		t.Fatal("failed create left a file")
	}
}

func TestDiscoverySelectionAndLiteralExecution(t *testing.T) {
	t.Setenv("SINAN_SCRIPT_TEST_HELPER", "1")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	p := testPlugin(t, t.TempDir())
	binDir, scriptsDir := t.TempDir(), t.TempDir()
	t.Setenv("PATH", binDir)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	for _, name := range []string{"python2", "python3", "node"} {
		put(t, filepath.Join(binDir, name+suffix), string(child))
	}
	envs := discover()
	for _, id := range []string{"path-python2", "path-python3", "path-node"} {
		if !slices.ContainsFunc(envs, func(e environment) bool { return e.ID == id }) {
			t.Fatal("PATH interpreter not discovered")
		}
	}
	// The space and ampersand must remain part of the literal argument.
	candidate := filepath.Join(scriptsDir, "a & b.py")
	put(t, candidate, "#!/usr/bin/env python2\nfixture")
	item := script{override: override{Path: candidate}}
	if env, err := interpreter(item, envs); err != nil || env.ID != "path-python2" {
		t.Fatal("Python shebang version not honored")
	}
	item.Environment = "path-python3"
	if env, err := interpreter(item, envs); err != nil || env.ID != "path-python3" {
		t.Fatal("manual environment override not honored")
	}
	apply(t, p, change{Action: "add-directory", Path: scriptsDir})
	apply(t, p, change{Action: "add-environment", Name: "自定义", Path: filepath.Join(binDir, "python3"+suffix)})
	matches := searchFor(t, p, "a & b")
	if len(matches) != 1 {
		t.Fatal("script name not indexed")
	}
	id := matches[0].Input
	apply(t, p, change{Action: "edit", ID: id, Environment: p.cfg.Environments[0].ID})
	if _, err := p.start(t.Context(), id, "library"); err != nil {
		t.Fatal(err)
	}
	waitForRun(t, p, id)
	p.mu.RLock()
	jobID := p.runs[id].result.ID
	p.mu.RUnlock()
	result, err := p.runStatus(jobID)
	if err != nil || !strings.Contains(result.Output, "fixture stdout") || !strings.Contains(result.Output, "fixture stderr") {
		t.Fatal("child output was not captured from both streams")
	}
	if body, err := os.ReadFile(filepath.Join(scriptsDir, "script-result")); err != nil || !strings.HasSuffix(string(body), "fixture") {
		t.Fatal("script did not receive literal argument and working directory")
	}

	path := filepath.Join(scriptsDir, "other"+suffix)
	put(t, path, string(child))
	apply(t, p, change{Action: "import", Path: path})
	matches = searchFor(t, p, "other")
	if len(matches) != 1 {
		t.Fatal("imported executable not indexed")
	}
	id = matches[0].Input
	if _, err := p.start(t.Context(), id, "library"); err != nil {
		t.Fatal(err)
	}
	waitForRun(t, p, id)
	if _, err := os.Stat(filepath.Join(scriptsDir, "direct-result")); err != nil {
		t.Fatal("direct execution did not use script directory")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if result, err := p.start(t.Context(), id, "library"); err == nil && result.Status != failed {
		t.Fatal("stale search result executed a missing file")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := scan(ctx, p.cfg); !errors.Is(err, context.Canceled) {
		t.Fatal("scan did not honor cancellation")
	}
}

func waitForRun(t *testing.T, p *plugin, id string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.RLock()
		latest := p.runs[id]
		state, delivery := latest.result.Status, latest.result.Delivery
		p.mu.RUnlock()
		switch state {
		case completed:
			if delivery != "pending" {
				return
			}
		case failed:
			t.Fatal("test script failed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("test script did not exit")
}
