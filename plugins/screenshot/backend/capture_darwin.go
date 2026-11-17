package main

import (
	"context"
)

func capturePlatform(ctx context.Context, path string) error {
	return run(ctx, "/usr/sbin/screencapture", "-i", "-s", "-x", "-t", "png", path)
}
