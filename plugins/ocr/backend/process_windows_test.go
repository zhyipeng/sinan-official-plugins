package main

import (
	"os/exec"
	"testing"
)

func TestWorkerDoesNotAllocateAConsole(t *testing.T) {
	cmd := exec.Command("not-launched")
	configureWorker(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatal("worker would allocate a console host")
	}
}
