package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"sinan-ocr/internal/workerio"
)

type boundedBuffer struct {
	bytes.Buffer
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	remaining := b.max - b.Len()
	if len(p) > remaining {
		b.Buffer.Write(p[:remaining])
		return remaining, errors.New("worker output exceeded limit")
	}
	return b.Buffer.Write(p)
}

func runWorker(ctx context.Context, root string, data []byte) (string, error) {
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	cmd := exec.CommandContext(ctx, filepath.Join(root, "backend", "ocr-worker"+suffix),
		"--det", filepath.Join(root, "models", "det.onnx"),
		"--rec", filepath.Join(root, "models", "rec.onnx"),
		"--dict", filepath.Join(root, "models", "dictionary.txt"))
	configureWorker(cmd)
	cmd.Dir = root
	cmd.Env = []string{"PPOCR_BENCH_THREADS=4"}
	for _, key := range []string{"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	out, stderr := &boundedBuffer{max: workerio.MaxReply}, &boundedBuffer{max: 4096}
	cmd.Stdout, cmd.Stderr = out, stderr
	pipe, err := cmd.StdinPipe()
	if err != nil {
		return "", errors.New("无法创建识别工作进程")
	}
	defer pipe.Close()
	if err = cmd.Start(); err != nil {
		return "", errors.New("识别引擎不可用，请重新构建或安装匹配平台的插件")
	}
	// Keep the writer open until Wait: EOF is the worker's parent-death signal.
	if err = workerio.Send(pipe, data); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return "", errors.New("图片传输失败")
	}
	if err = cmd.Wait(); err != nil {
		return "", errors.New("识别工作进程失败，请重试或缩小图片")
	}
	var reply workerio.Reply
	decoder := json.NewDecoder(bytes.NewReader(out.Bytes()))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&reply) != nil || decoder.Decode(new(any)) != io.EOF || !workerio.ValidText(reply.Text) {
		return "", errors.New("识别引擎返回了无效结果")
	}
	return reply.Text, nil
}
