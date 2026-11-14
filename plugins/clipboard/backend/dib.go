package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math/bits"
)

// Windows DIB payloads have no BMP file header. Decode only bounded 24/32-bit
// RGB or contiguous bitfield layouts, including top-down V4/V5 screenshots.
func decodeDIB(data []byte) ([]byte, error) {
	invalid := errors.New("unsupported clipboard bitmap")
	if len(data) < 40 {
		return nil, invalid
	}
	header := uint64(binary.LittleEndian.Uint32(data))
	w := int64(int32(binary.LittleEndian.Uint32(data[4:])))
	signedH := int64(int32(binary.LittleEndian.Uint32(data[8:])))
	h := signedH
	if h < 0 {
		h = -h
	}
	depth := binary.LittleEndian.Uint16(data[14:])
	compression := binary.LittleEndian.Uint32(data[16:])
	if header < 40 || header > uint64(len(data)) || w <= 0 || h <= 0 || w*h > 16_000_000 || binary.LittleEndian.Uint16(data[12:]) != 1 || (depth != 24 && depth != 32) {
		return nil, invalid
	}
	offset := header
	masks := [4]uint32{0xff0000, 0xff00, 0xff, 0}
	if compression == 3 || compression == 6 {
		if depth != 32 {
			return nil, invalid
		}
		if header >= 52 {
			for i := 0; i < 3; i++ {
				masks[i] = binary.LittleEndian.Uint32(data[40+i*4:])
			}
			if header >= 56 {
				masks[3] = binary.LittleEndian.Uint32(data[52:])
			} else if compression == 6 {
				return nil, invalid
			}
		} else if header == 40 {
			count := 3
			if compression == 6 {
				count = 4
			}
			if uint64(len(data)) < offset+uint64(count*4) {
				return nil, invalid
			}
			for i := 0; i < count; i++ {
				masks[i] = binary.LittleEndian.Uint32(data[int(offset)+i*4:])
			}
			offset += uint64(count * 4)
		} else {
			return nil, invalid
		}
		occupied := uint32(0)
		for i, mask := range masks {
			if mask == 0 {
				if i < 3 {
					return nil, invalid
				}
				continue
			}
			normalized := mask >> bits.TrailingZeros32(mask)
			if normalized&(normalized+1) != 0 || occupied&mask != 0 {
				return nil, invalid
			}
			occupied |= mask
		}
	} else if compression != 0 {
		return nil, invalid
	}
	// A color table may follow a 24/32-bit header. Bound it before pixel access.
	colors := uint64(binary.LittleEndian.Uint32(data[32:]))
	if colors > 256 {
		return nil, invalid
	}
	offset += colors * 4
	stride := ((uint64(w)*uint64(depth) + 31) / 32) * 4
	if offset+stride*uint64(h) > uint64(len(data)) {
		return nil, invalid
	}
	channel := func(pixel, mask uint32, fallback byte) byte {
		if mask == 0 {
			return fallback
		}
		shift := bits.TrailingZeros32(mask)
		max := uint64(mask >> shift)
		return byte((uint64((pixel&mask)>>shift)*255 + max/2) / max)
	}
	img := image.NewNRGBA(image.Rect(0, 0, int(w), int(h)))
	for y := 0; y < int(h); y++ {
		row := y
		if signedH > 0 {
			row = int(h) - 1 - y
		}
		for x := 0; x < int(w); x++ {
			at := int(offset) + row*int(stride) + x*int(depth/8)
			c := color.NRGBA{data[at+2], data[at+1], data[at], 255}
			if depth == 32 {
				pixel := binary.LittleEndian.Uint32(data[at:])
				c = color.NRGBA{channel(pixel, masks[0], 0), channel(pixel, masks[1], 0), channel(pixel, masks[2], 0), channel(pixel, masks[3], 255)}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	if out.Len() > maxImage {
		return nil, invalid
	}
	return out.Bytes(), nil
}
func encodeDIB(data []byte) ([]byte, error) {
	if _, _, err := validate(content{"image", data}); err != nil {
		return nil, err
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	out := make([]byte, 40+w*h*4)
	binary.LittleEndian.PutUint32(out, 40)
	binary.LittleEndian.PutUint32(out[4:], uint32(w))
	binary.LittleEndian.PutUint32(out[8:], uint32(h))
	binary.LittleEndian.PutUint16(out[12:], 1)
	binary.LittleEndian.PutUint16(out[14:], 32)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.NRGBAModel.Convert(img.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
			a := uint32(c.A)
			offset := 40 + ((h-1-y)*w+x)*4
			overWhite := func(v byte) byte { return byte((uint32(v)*a + 255*(255-a) + 127) / 255) }
			out[offset] = overWhite(c.B)
			out[offset+1] = overWhite(c.G)
			out[offset+2] = overWhite(c.R)
		}
	}
	return out, nil
}
