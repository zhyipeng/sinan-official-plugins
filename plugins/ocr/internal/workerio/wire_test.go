package workerio

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
	"time"
)

func TestParentPipeLifetime(t *testing.T) {
	in, out := io.Pipe()
	lost := make(chan struct{})
	go func() { _ = Send(out, []byte("fixture image")) }()
	data, err := Receive(in, func() { close(lost) })
	if err != nil || string(data) != "fixture image" {
		t.Fatal("frame did not arrive")
	}
	select {
	case <-lost:
		t.Fatal("open parent pipe treated as dead")
	default:
	}
	_ = out.Close()
	select {
	case <-lost:
	case <-time.After(time.Second):
		t.Fatal("parent EOF did not revoke worker lifetime")
	}
}

func TestFrameRejectsOversizeAndTruncation(t *testing.T) {
	var huge [4]byte
	binary.BigEndian.PutUint32(huge[:], MaxPNG+1)
	for _, data := range [][]byte{nil, {0, 0, 0, 0}, {0, 0, 0, 2, 1}, huge[:]} {
		if _, err := Receive(bytes.NewReader(data), func() { t.Error("invalid frame admitted") }); err == nil {
			t.Fatal("invalid frame accepted")
		}
	}
}
