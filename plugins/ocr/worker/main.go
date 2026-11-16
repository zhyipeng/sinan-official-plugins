//go:build ocr_native && cgo

// The OCR worker reads exactly one PNG and exits. Its parent's open stdin pipe
// is a lifetime guard even while the main OS thread is executing C++.
package main

/*
#include <stdlib.h>
#include "ppocr/ppocr.h"
static int recognize_rgb(ppocr_ocr *ocr, int w, int h,
                         const unsigned char *rgb, ppocr_result *out) {
  ppocr_image image = {w, h, rgb};
  return ppocr_recognize(ocr, &image, out);
}
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"image/png"
	"os"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"sinan-ocr/internal/workerio"
)

func recognize(data []byte, det, rec, dict string) (string, error) {
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > workerio.MaxPixels/cfg.Height {
		return "", errors.New("invalid PNG dimensions")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("invalid PNG")
	}
	rgb := make([]byte, cfg.Width*cfg.Height*3)
	for y := 0; y < cfg.Height; y++ {
		for x := 0; x < cfg.Width; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			i := (y*cfg.Width + x) * 3
			rgb[i], rgb[i+1], rgb[i+2] = byte((r+65535-a)>>8), byte((g+65535-a)>>8), byte((b+65535-a)>>8)
		}
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var options C.ppocr_options
	C.ppocr_options_init(&options)
	options.backend = C.PPOCR_BACKEND_CPU
	options.det_threshold, options.det_box_threshold, options.det_unclip_ratio = 0.3, 0.5, 1.6
	options.det_limit_side_len, options.det_limit_type = 960, 0
	options.rec_batch_size, options.det_use_dilation = 1, 1
	for i := 0; i < 3; i++ {
		options.det_mean[i], options.det_std[i] = 0.5, 0.5
		options.rec_mean[i], options.rec_std[i] = 0.5, 0.5
	}
	d, r, k := C.CString(det), C.CString(rec), C.CString(dict)
	defer C.free(unsafe.Pointer(d))
	defer C.free(unsafe.Pointer(r))
	defer C.free(unsafe.Pointer(k))
	handle := C.ppocr_create(d, r, k, &options)
	if handle == nil {
		return "", errors.New("native initialization failed")
	}
	defer C.ppocr_destroy(handle)
	var result C.ppocr_result
	status := C.recognize_rgb(handle, C.int(cfg.Width), C.int(cfg.Height), (*C.uchar)(unsafe.Pointer(&rgb[0])), &result)
	runtime.KeepAlive(rgb)
	defer C.ppocr_result_free(&result)
	if status != C.PPOCR_OK || result.count > 1000 || (result.count > 0 && result.items == nil) {
		return "", errors.New("native inference failed")
	}
	var text strings.Builder
	for _, item := range unsafe.Slice(result.items, int(result.count)) {
		line := C.GoString(item.text)
		if item.confidence < 0.5 || strings.TrimSpace(line) == "" {
			continue
		}
		if text.Len() > 0 {
			text.WriteByte('\n')
		}
		if text.Len()+len(line) > workerio.MaxText {
			return "", errors.New("result exceeded text limit")
		}
		text.WriteString(line)
	}
	if !workerio.ValidText(text.String()) {
		return "", errors.New("invalid text result")
	}
	return text.String(), nil
}

func main() {
	det := flag.String("det", "", "detector")
	rec := flag.String("rec", "", "recognizer")
	dict := flag.String("dict", "", "dictionary")
	probe := flag.Bool("probe", false, "check native ABI without loading models")
	flag.Parse()
	if *probe {
		var cpu C.ppocr_cpu_info
		C.ppocr_query_cpu_info(&cpu)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"engine": "RapidOCRLite 5.0.0a6", "isa": C.GoString(&cpu.active_isa[0])})
		return
	}
	if *det == "" || *rec == "" || *dict == "" {
		os.Exit(2)
	}
	deadline := time.AfterFunc(35*time.Second, func() { os.Exit(2) })
	defer deadline.Stop()
	data, err := workerio.Receive(os.Stdin, func() { os.Exit(2) })
	if err != nil {
		os.Exit(2)
	}
	text, err := recognize(data, *det, *rec, *dict)
	if err != nil {
		// Do not log image contents, recognized text, paths or native diagnostics.
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(workerio.Reply{Text: text}) != nil {
		os.Exit(1)
	}
}
