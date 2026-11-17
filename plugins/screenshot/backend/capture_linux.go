package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

func capturePlatform(ctx context.Context, path string) error {
	if os.Getenv("WAYLAND_DISPLAY") != "" || strings.EqualFold(os.Getenv("XDG_SESSION_TYPE"), "wayland") {
		if _, err := exec.LookPath("grim"); err != nil {
			return errors.New("Wayland 区域截图需要 grim 和 slurp，且合成器须支持 screencopy；GNOME/KDE Portal 暂未接入")
		}
		if _, err := exec.LookPath("slurp"); err != nil {
			return errors.New("Wayland 区域截图需要安装 slurp")
		}
		cmd := exec.CommandContext(ctx, "slurp", "-f", "%x,%y %wx%h")
		var out strings.Builder
		cmd.Stdout = &out
		if err := cmd.Run(); err != nil {
			return errors.New("选区已取消或当前 Wayland 合成器不支持 slurp")
		}
		geometry := strings.TrimSpace(out.String())
		if len(geometry) == 0 || len(geometry) > 128 {
			return errors.New("选区无效")
		}
		return run(ctx, "grim", "-g", geometry, path)
	}
	if os.Getenv("DISPLAY") == "" {
		return errors.New("区域截图需要 X11 或受支持的 Wayland 桌面会话")
	}
	if _, err := exec.LookPath("scrot"); err != nil {
		return errors.New("X11 区域截图需要安装 scrot")
	}
	return run(ctx, "scrot", "--select", "--freeze", path)
}
