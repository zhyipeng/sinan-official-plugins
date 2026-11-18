//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func replaceFile(from, to string) error { return os.Rename(from, to) }

func executable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0
}

func background(*exec.Cmd) {}

func openScriptHeader(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
