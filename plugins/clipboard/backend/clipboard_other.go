//go:build (!darwin && !windows && !linux) || (darwin && !cgo)

package main

import "errors"

func readClipboard(previous uint64) (content, uint64, error) {
	return content{}, previous, errors.New("unsupported")
}
func writeClipboard(content) error { return errors.New("unsupported") }
