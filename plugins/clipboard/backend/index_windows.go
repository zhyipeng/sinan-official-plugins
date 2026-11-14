//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func replaceIndex(path string, data []byte) error { return atomicFile(path, data) }
func moveFile(from, to string) error {
	src, _ := syscall.UTF16PtrFromString(from)
	dst, _ := syscall.UTF16PtrFromString(to)
	ok, _, err := syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW").Call(uintptr(unsafe.Pointer(src)), uintptr(unsafe.Pointer(dst)), 9)
	if ok == 0 {
		return err
	}
	return nil
}
