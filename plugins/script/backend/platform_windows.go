package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var moveFile = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

func replaceFile(from, to string) error {
	src, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	dst, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	const replaceExistingAndWriteThrough = 0x1 | 0x8
	ok, _, err := moveFile.Call(uintptr(unsafe.Pointer(src)), uintptr(unsafe.Pointer(dst)), replaceExistingAndWriteThrough)
	if ok == 0 {
		return err
	}
	return nil
}

func executable(path string) bool {
	ext := filepath.Ext(path)
	if !strings.EqualFold(ext, ".exe") && !strings.EqualFold(ext, ".com") {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func background(cmd *exec.Cmd) {
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
}

func openScriptHeader(path string) (*os.File, error) { return os.Open(path) }
