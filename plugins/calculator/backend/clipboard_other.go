//go:build !darwin && !linux && !windows

package main

import (
	"context"
	"errors"
)

func copyText(context.Context, string) error {
	return errors.New("当前平台不支持剪贴板写入")
}
