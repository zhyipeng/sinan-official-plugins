//go:build !windows

package main

import "os"

func replaceIndex(path string, data []byte) error { return atomicFile(path, data) }
func moveFile(from, to string) error              { return os.Rename(from, to) }
