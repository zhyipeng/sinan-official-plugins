//go:build !darwin && !windows

package main

import (
	"context"
	"errors"
)

func capturePlatform(context.Context, string, bool) (captureAction, error) {
	return "", errors.New("截图插件支持 macOS 和 Windows")
}
