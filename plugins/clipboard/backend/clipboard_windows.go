//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"runtime"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var user32 = syscall.NewLazyDLL("user32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")

func withClipboard(fn func() error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	class, _ := syscall.UTF16PtrFromString("STATIC")
	hwnd, _, _ := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), 0, 0, 0, 0, 0, 0, ^uintptr(2), 0, 0, 0)
	if hwnd == 0 {
		return errors.New("clipboard owner unavailable")
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	opened := false
	for attempt := 0; attempt < 4; attempt++ {
		ok, _, _ := user32.NewProc("OpenClipboard").Call(hwnd)
		if ok != 0 {
			opened = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !opened {
		return errors.New("clipboard busy")
	}
	defer user32.NewProc("CloseClipboard").Call()
	return fn()
}
func pngFormat() uintptr {
	name, _ := syscall.UTF16PtrFromString("PNG")
	format, _, _ := user32.NewProc("RegisterClipboardFormatW").Call(uintptr(unsafe.Pointer(name)))
	return format
}
func globalBytes(format uintptr, limit int) []byte {
	if format == 0 {
		return nil
	}
	h, _, _ := user32.NewProc("GetClipboardData").Call(format)
	if h == 0 {
		return nil
	}
	size, _, _ := kernel32.NewProc("GlobalSize").Call(h)
	if size == 0 || size > uintptr(limit) {
		return nil
	}
	ptr, _, _ := kernel32.NewProc("GlobalLock").Call(h)
	if ptr == 0 {
		return nil
	}
	defer kernel32.NewProc("GlobalUnlock").Call(h)
	return bytes.Clone(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), int(size)))
}
func readClipboard(previous uint64) (content, uint64, error) {
	seq, _, _ := user32.NewProc("GetClipboardSequenceNumber").Call()
	if uint64(seq) == previous {
		return content{}, previous, nil
	}
	var c content
	err := withClipboard(func() error {
		// Snapshot the sequence while the clipboard is locked against other owners.
		seq, _, _ = user32.NewProc("GetClipboardSequenceNumber").Call()
		if raw := globalBytes(pngFormat(), maxImage); len(raw) > 0 {
			candidate := content{"image", raw}
			if _, _, err := validate(candidate); err == nil {
				c = candidate
				return nil
			}
		}
		for _, format := range []uintptr{17, 8} {
			if raw := globalBytes(format, 64<<20); len(raw) > 0 {
				if png, err := decodeDIB(raw); err == nil {
					c = content{"image", png}
					return nil
				}
			}
		}
		raw := globalBytes(13, maxText*2+2)
		if len(raw) >= 2 {
			units := make([]uint16, 0, len(raw)/2)
			for i := 0; i+1 < len(raw); i += 2 {
				u := binary.LittleEndian.Uint16(raw[i:])
				if u == 0 {
					break
				}
				units = append(units, u)
			}
			c = content{"text", []byte(string(utf16.Decode(units)))}
		}
		return nil
	})
	if err != nil {
		return content{}, previous, err
	}
	return c, uint64(seq), nil
}

type clipboardFormat struct {
	format uintptr
	data   []byte
	memory uintptr
}

func writeClipboard(c content) error {
	if _, _, err := validate(c); err != nil {
		return err
	}
	formats := []clipboardFormat{}
	if c.Kind == "text" {
		units := utf16.Encode([]rune(string(c.Data)))
		data := make([]byte, (len(units)+1)*2)
		for i, u := range units {
			binary.LittleEndian.PutUint16(data[i*2:], u)
		}
		formats = append(formats, clipboardFormat{format: 13, data: data})
	} else {
		dib, err := encodeDIB(c.Data)
		if err != nil {
			return err
		}
		if format := pngFormat(); format != 0 {
			formats = append(formats, clipboardFormat{format: format, data: c.Data})
		}
		formats = append(formats, clipboardFormat{format: 8, data: dib})
	}
	return withClipboard(func() error {
		// Allocate all formats before clearing the user's current clipboard. Once
		// SetClipboardData succeeds Windows owns that allocation, including PNG alpha.
		defer func() {
			for _, f := range formats {
				if f.memory != 0 {
					kernel32.NewProc("GlobalFree").Call(f.memory)
				}
			}
		}()
		for i := range formats {
			mem, _, _ := kernel32.NewProc("GlobalAlloc").Call(0x42, uintptr(len(formats[i].data)))
			if mem == 0 {
				return errors.New("allocation failed")
			}
			formats[i].memory = mem
			ptr, _, _ := kernel32.NewProc("GlobalLock").Call(mem)
			if ptr == 0 {
				return errors.New("lock failed")
			}
			copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(formats[i].data)), formats[i].data)
			kernel32.NewProc("GlobalUnlock").Call(mem)
		}
		ok, _, _ := user32.NewProc("EmptyClipboard").Call()
		if ok == 0 {
			return errors.New("clipboard unavailable")
		}
		written := false
		for i := range formats {
			ok, _, _ := user32.NewProc("SetClipboardData").Call(formats[i].format, formats[i].memory)
			if ok != 0 {
				formats[i].memory = 0
				written = true
			}
		}
		if !written {
			return errors.New("write failed")
		}
		return nil
	})
}
