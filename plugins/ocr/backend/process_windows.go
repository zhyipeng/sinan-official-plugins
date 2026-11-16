package main

import (
	"os/exec"
	"syscall"
)

func configureWorker(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
