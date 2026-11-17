package main

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW prevents an invisible conhost from being allocated when
// the native worker starts from a background plugin with no console.
const createNoWindow = 0x08000000

func configureWorker(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
