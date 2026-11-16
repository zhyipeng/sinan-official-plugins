// Package workerio defines the plugin-private parent/worker pipe, not Host API.
package workerio

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"unicode/utf8"
)

const MaxPNG = 8 << 20
const MaxPixels = 16_000_000
const MaxText = 32 << 10
const MaxReply = 128 << 10

type Reply struct {
	Text string `json:"text"`
}

// Receive reads one image, then watches the still-open pipe. EOF or unexpected
// extra input means the owner is gone. lost must terminate the worker, including
// any synchronous C++ inference in another OS thread.
func Receive(in io.Reader, lost func()) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(in, header[:]); err != nil {
		return nil, errors.New("未收到图片")
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > MaxPNG {
		return nil, errors.New("图片超过 8 MiB 限制")
	}
	data := make([]byte, int(n))
	if _, err := io.ReadFull(in, data); err != nil {
		return nil, errors.New("图片传输中断")
	}
	go func() {
		var unexpected [1]byte
		_, _ = io.ReadFull(in, unexpected[:])
		lost()
	}()
	return data, nil
}

func Send(out io.Writer, png []byte) error {
	if len(png) == 0 || len(png) > MaxPNG {
		return errors.New("图片超过限制")
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(png)))
	if _, err := io.Copy(out, bytes.NewReader(header[:])); err != nil {
		return err
	}
	_, err := io.Copy(out, bytes.NewReader(png))
	return err
}

func ValidText(text string) bool {
	if len(text) > MaxText || !utf8.ValidString(text) {
		return false
	}
	for _, r := range text {
		if r == 0 {
			return false
		}
	}
	return true
}
