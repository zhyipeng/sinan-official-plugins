package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"sinan-ocr/internal/workerio"
)

// Child fixtures use the production framing/EOF guard, without C++ or a desktop.
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "--parent-helper" {
		_, _ = runWorker(context.Background(), os.Args[2], imageFixture())
		os.Exit(0)
	}
	if len(os.Args) > 2 && os.Args[1] == "--det" {
		root := filepath.Dir(filepath.Dir(os.Args[2]))
		_, err := workerio.Receive(os.Stdin, func() {
			_ = os.WriteFile(filepath.Join(root, "parent-lost"), []byte("closed"), 0600)
			os.Exit(2)
		})
		if err != nil {
			os.Exit(2)
		}
		mode, _ := os.ReadFile(os.Args[2])
		switch string(mode) {
		case "block":
			_ = os.WriteFile(filepath.Join(root, "worker-started"), []byte("ready"), 0600)
			time.Sleep(time.Hour)
		case "invalid":
			_, _ = io.WriteString(os.Stdout, `{"text":"\u0000"}`)
		case "overflow":
			_, _ = io.WriteString(os.Stdout, strings.Repeat("x", workerio.MaxReply+1))
		default:
			_ = json.NewEncoder(os.Stdout).Encode(workerio.Reply{Text: "合成文字 OCR"})
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func workerFixture(t *testing.T, mode string) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "中文目录")
	if err := os.MkdirAll(filepath.Join(root, "backend"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "models"), 0700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	if err := os.WriteFile(filepath.Join(root, "backend", "ocr-worker"+suffix), data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "models", "det.onnx"), []byte(mode), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func waitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("worker lifetime event did not arrive")
}

func TestWorkerPipeResultsAndBounds(t *testing.T) {
	for _, mode := range []string{"ok", "invalid", "overflow"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			text, err := runWorker(ctx, workerFixture(t, mode), imageFixture())
			if mode == "ok" {
				if err != nil || text != "合成文字 OCR" {
					t.Fatal("lost worker reply", err)
				}
			} else if err == nil || text != "" {
				t.Fatal("invalid native output accepted")
			}
		})
	}
}

func TestWorkerDeadlineReapsProcess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := runWorker(ctx, workerFixture(t, "block"), imageFixture()); err == nil {
		t.Fatal("worker ignored deadline")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("cancelled worker was not reaped promptly")
	}
}

func TestBackendKilledWorkerObservesEOF(t *testing.T) {
	root := workerFixture(t, "block")
	self, _ := os.Executable()
	cmd := exec.Command(self, "--parent-helper", root)
	configureWorker(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill() }()
	waitFile(t, filepath.Join(root, "worker-started"))
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	waitFile(t, filepath.Join(root, "parent-lost"))
}
