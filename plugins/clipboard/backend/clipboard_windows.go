//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"runtime"
	"syscall"
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
	ok, _, _ := user32.NewProc("OpenClipboard").Call(hwnd)
	if ok == 0 {
		return errors.New("clipboard busy")
	}
	defer user32.NewProc("CloseClipboard").Call()
	return fn()
}
func globalBytes(format uintptr, limit int) []byte {
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
		pngName, _ := syscall.UTF16PtrFromString("PNG")
		pngFormat, _, _ := user32.NewProc("RegisterClipboardFormatW").Call(uintptr(unsafe.Pointer(pngName)))
		if raw := globalBytes(pngFormat, maxImage); len(raw) > 0 {
			candidate := content{"image", raw}
			if _, _, err := validate(candidate); err == nil {
				c = candidate
				return nil
			}
		}
		b := globalBytes(8, 64<<20)
		if len(b) >= 40 {
			header := int(binary.LittleEndian.Uint32(b))
			w := int(int32(binary.LittleEndian.Uint32(b[4:])))
			signedH := int(int32(binary.LittleEndian.Uint32(b[8:])))
			h := signedH
			if h < 0 {
				h = -h
			}
			bits := int(binary.LittleEndian.Uint16(b[14:]))
			compression := binary.LittleEndian.Uint32(b[16:])
			stride := ((w*bits + 31) / 32) * 4
			if header >= 40 && header <= len(b) && w > 0 && h > 0 && int64(w)*int64(h) <= 16_000_000 && (bits == 24 || bits == 32) && compression == 0 && stride > 0 && int64(header)+int64(stride)*int64(h) <= int64(len(b)) {
				img := image.NewNRGBA(image.Rect(0, 0, w, h))
				for y := 0; y < h; y++ {
					row := y
					if signedH > 0 {
						row = h - 1 - y
					}
					for x := 0; x < w; x++ {
						offset := header + row*stride + x*(bits/8)
						img.SetNRGBA(x, y, color.NRGBA{b[offset+2], b[offset+1], b[offset], 255})
					}
				}
				var out bytes.Buffer
				if png.Encode(&out, img) == nil {
					c = content{"image", out.Bytes()}
					return nil
				}
			}
		}
		b = globalBytes(13, maxText*2+2)
		if len(b) >= 2 {
			units := make([]uint16, 0, len(b)/2)
			for i := 0; i+1 < len(b); i += 2 {
				u := binary.LittleEndian.Uint16(b[i:])
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
func writeClipboard(c content) error {
	var data []byte
	format := uintptr(13)
	if c.Kind == "text" {
		units := utf16.Encode([]rune(string(c.Data)))
		data = make([]byte, (len(units)+1)*2)
		for i, u := range units {
			binary.LittleEndian.PutUint16(data[i*2:], u)
		}
	} else {
		img, err := png.Decode(bytes.NewReader(c.Data))
		if err != nil {
			return err
		}
		b := img.Bounds()
		w, h := b.Dx(), b.Dy()
		data = make([]byte, 40+w*h*4)
		binary.LittleEndian.PutUint32(data, 40)
		binary.LittleEndian.PutUint32(data[4:], uint32(w))
		binary.LittleEndian.PutUint32(data[8:], uint32(h))
		binary.LittleEndian.PutUint16(data[12:], 1)
		binary.LittleEndian.PutUint16(data[14:], 32)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				r, g, bb, _ := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
				offset := 40 + ((h-1-y)*w+x)*4
				data[offset] = byte(bb >> 8)
				data[offset+1] = byte(g >> 8)
				data[offset+2] = byte(r >> 8)
			}
		}
		format = 8
	}
	return withClipboard(func() error {
		mem, _, _ := kernel32.NewProc("GlobalAlloc").Call(0x42, uintptr(len(data)))
		if mem == 0 {
			return errors.New("allocation failed")
		}
		ptr, _, _ := kernel32.NewProc("GlobalLock").Call(mem)
		if ptr == 0 {
			kernel32.NewProc("GlobalFree").Call(mem)
			return errors.New("lock failed")
		}
		copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(data)), data)
		kernel32.NewProc("GlobalUnlock").Call(mem)
		user32.NewProc("EmptyClipboard").Call()
		ok, _, _ := user32.NewProc("SetClipboardData").Call(format, mem)
		if ok == 0 {
			kernel32.NewProc("GlobalFree").Call(mem)
			return errors.New("write failed")
		}
		return nil
	})
}
