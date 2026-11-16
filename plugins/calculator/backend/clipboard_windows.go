//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"errors"
	"runtime"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

func copyText(ctx context.Context, text string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	user := syscall.NewLazyDLL("user32.dll")
	kernel := syscall.NewLazyDLL("kernel32.dll")
	class, _ := syscall.UTF16PtrFromString("STATIC")
	hwnd, _, _ := user.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), 0, 0, 0, 0, 0, 0, 0, ^uintptr(2), 0, 0)
	if hwnd == 0 {
		return errors.New("无法创建剪贴板所有者")
	}
	defer user.NewProc("DestroyWindow").Call(hwnd)
	opened := false
	for attempt := 0; attempt < 4; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		ok, _, _ := user.NewProc("OpenClipboard").Call(hwnd)
		if ok != 0 {
			opened = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !opened {
		return errors.New("剪贴板正忙，请重试")
	}
	defer user.NewProc("CloseClipboard").Call()
	units := utf16.Encode([]rune(text))
	data := make([]byte, (len(units)+1)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(data[i*2:], u)
	}
	mem, _, _ := kernel.NewProc("GlobalAlloc").Call(0x42, uintptr(len(data)))
	if mem == 0 {
		return errors.New("剪贴板内存分配失败")
	}
	defer func() {
		if mem != 0 {
			kernel.NewProc("GlobalFree").Call(mem)
		}
	}()
	ptr, _, _ := kernel.NewProc("GlobalLock").Call(mem)
	if ptr == 0 {
		return errors.New("剪贴板内存锁定失败")
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(data)), data)
	kernel.NewProc("GlobalUnlock").Call(mem)
	if err := ctx.Err(); err != nil {
		return err
	}
	ok, _, _ := user.NewProc("EmptyClipboard").Call()
	if ok == 0 {
		return errors.New("无法清空剪贴板")
	}
	ok, _, _ = user.NewProc("SetClipboardData").Call(13, mem)
	if ok == 0 {
		return errors.New("剪贴板写入失败")
	}
	mem = 0
	return nil
}
