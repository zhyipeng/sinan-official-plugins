//go:build !darwin && !linux && !windows

package main

import (
	"context"
	"errors"
)

func capturePlatform(context.Context, string) error {
	return errors.New("当前平台不支持区域截图")
}
