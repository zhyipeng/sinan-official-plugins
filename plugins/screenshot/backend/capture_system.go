//go:build !darwin

package main

import "context"

func capturePlatform(ctx context.Context, path string, _ bool) (captureAction, error) {
	return "", captureSystemRegion(ctx, path)
}
