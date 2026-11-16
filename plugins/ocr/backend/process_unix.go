//go:build !windows

package main

import "os/exec"

func configureWorker(*exec.Cmd) {}
