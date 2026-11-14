package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func dibFixture(header, w, h, depth int) []byte {
	height := h
	if height < 0 {
		height = -height
	}
	stride := ((w*depth + 31) / 32) * 4
	b := make([]byte, header+stride*height)
	binary.LittleEndian.PutUint32(b, uint32(header))
	binary.LittleEndian.PutUint32(b[4:], uint32(w))
	binary.LittleEndian.PutUint32(b[8:], uint32(int32(h)))
	binary.LittleEndian.PutUint16(b[12:], 1)
	binary.LittleEndian.PutUint16(b[14:], uint16(depth))
	return b
}
func dibPixel(t *testing.T, b []byte, x, y int) color.NRGBA {
	t.Helper()
	encoded, err := decodeDIB(b)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	return color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
}
func TestDIBRowsPaddingAndAlpha(t *testing.T) {
	b := dibFixture(40, 1, 2, 24)
	copy(b[40:], []byte{255, 0, 0, 0, 0, 0, 255, 0})
	if dibPixel(t, b, 0, 0) != (color.NRGBA{255, 0, 0, 255}) || dibPixel(t, b, 0, 1) != (color.NRGBA{0, 0, 255, 255}) {
		t.Fatal("bottom-up padded rows decoded incorrectly")
	}
	b = dibFixture(124, 1, -1, 32)
	binary.LittleEndian.PutUint32(b[16:], 3)
	for i, mask := range []uint32{0xff0000, 0xff00, 0xff, 0xff000000} {
		binary.LittleEndian.PutUint32(b[40+i*4:], mask)
	}
	copy(b[124:], []byte{30, 20, 10, 128})
	if dibPixel(t, b, 0, 0) != (color.NRGBA{10, 20, 30, 128}) {
		t.Fatal("V5 bitfield alpha lost")
	}
	b = dibFixture(40, 1, 1, 32)
	copy(b[40:], []byte{30, 20, 10, 0})
	if dibPixel(t, b, 0, 0).A != 255 {
		t.Fatal("BI_RGB reserved byte treated as transparency")
	}
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	img.SetNRGBA(0, 0, color.NRGBA{0, 0, 0, 0})
	var raw bytes.Buffer
	_ = png.Encode(&raw, img)
	encoded, err := encodeDIB(raw.Bytes())
	if err != nil || dibPixel(t, encoded, 0, 0) != (color.NRGBA{255, 255, 255, 255}) {
		t.Fatal("DIB compatibility fallback did not composite over white")
	}
}
func TestDIBRejectsInvalidPayloads(t *testing.T) {
	for _, mutate := range []func([]byte) []byte{
		func(b []byte) []byte { return b[:39] }, func(b []byte) []byte { return b[:len(b)-1] },
		func(b []byte) []byte { binary.LittleEndian.PutUint32(b[4:], 0x7fffffff); return b },
		func(b []byte) []byte { binary.LittleEndian.PutUint16(b[12:], 0); return b },
		func(b []byte) []byte { binary.LittleEndian.PutUint32(b[16:], 1); return b },
		func(b []byte) []byte { binary.LittleEndian.PutUint32(b[32:], 0xffffffff); return b },
		func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[16:], 3)
			binary.LittleEndian.PutUint32(b[40:], 0xff)
			binary.LittleEndian.PutUint32(b[44:], 0xff)
			binary.LittleEndian.PutUint32(b[48:], 0xff00)
			return b
		},
	} {
		if _, err := decodeDIB(mutate(dibFixture(124, 2, 2, 32))); err == nil {
			t.Fatal("invalid bitmap accepted")
		}
	}
}
