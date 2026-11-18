package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxPath      = 1024
	maxConfig    = 2 << 20
	maxLocations = 16
	maxOverrides = 512
	direct       = "direct"
)

type environment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type override struct {
	Path           string   `json:"path"`
	Environment    string   `json:"environment,omitempty"`
	Keywords       []string `json:"keywords,omitempty"`
	Imported       bool     `json:"imported,omitempty"`
	HideFromSearch bool     `json:"hideFromSearch,omitempty"`
	ShowOutput     bool     `json:"showOutput,omitempty"`
}

type configuration struct {
	Directories  []string            `json:"directories"`
	Environments []environment       `json:"environments"`
	Scripts      map[string]override `json:"scripts"`
}

type change struct {
	HideFromSearch *bool    `json:"hideFromSearch"`
	ShowOutput     *bool    `json:"showOutput"`
	Action         string   `json:"action"`
	ID             string   `json:"id"`
	Path           string   `json:"path"`
	Name           string   `json:"name"`
	Text           string   `json:"text"`
	Environment    string   `json:"environment"`
	Keywords       []string `json:"keywords"`
}

func absolutePath(path string) (string, error) {
	if len(path) > maxPath || !utf8.ValidString(path) || !filepath.IsAbs(path) || strings.ContainsFunc(path, unicode.IsControl) {
		return "", errors.New("路径须为受支持的绝对路径")
	}
	return filepath.Clean(path), nil
}

func pathKey(path string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

func loadConfig(dir string) (configuration, error) {
	cfg := configuration{Directories: []string{}, Environments: []environment{}, Scripts: map[string]override{}}
	if dir == "" || os.MkdirAll(dir, 0700) != nil {
		return cfg, errors.New("脚本配置目录不可用")
	}
	file, err := os.Open(filepath.Join(dir, "scripts.json"))
	if os.IsNotExist(err) {
		return cfg, nil
	}
	if err != nil {
		return cfg, errors.New("无法读取脚本配置")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxConfig+1))
	if err != nil || len(data) > maxConfig || json.Unmarshal(data, &cfg) != nil || cfg.Scripts == nil ||
		cfg.Directories == nil || cfg.Environments == nil ||
		len(cfg.Directories) > maxLocations || len(cfg.Environments) > maxLocations || len(cfg.Scripts) > maxOverrides {
		return cfg, errors.New("脚本配置不可用")
	}
	for _, path := range cfg.Directories {
		if !validStoredPath(path) {
			return cfg, errors.New("脚本配置中的目录无效")
		}
	}
	for _, env := range cfg.Environments {
		if !validStoredPath(env.Path) || env.Name == "" || len(env.Name) > 120 ||
			strings.ContainsFunc(env.Name, unicode.IsControl) || env.ID != "manual-"+hash(env.Name+"\x00"+pathKey(env.Path)) {
			return cfg, errors.New("脚本配置中的环境无效")
		}
	}
	for key, entry := range cfg.Scripts {
		_, err := cleanKeywords(entry.Keywords)
		if !validStoredPath(entry.Path) || key != pathKey(entry.Path) || err != nil || len(entry.Environment) > 71 {
			return cfg, errors.New("脚本配置中的条目无效")
		}
	}
	return cfg, nil
}

func validStoredPath(path string) bool {
	clean, err := absolutePath(path)
	return err == nil && clean == path
}

func saveConfig(dir string, cfg configuration) error {
	data, err := json.Marshal(cfg)
	if err != nil || len(data) > maxConfig {
		return errors.New("脚本配置超过容量限制")
	}
	file, err := os.CreateTemp(dir, ".scripts-*")
	if err != nil {
		return errors.New("无法保存脚本配置")
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil || replaceFile(file.Name(), filepath.Join(dir, "scripts.json")) != nil {
		return errors.New("无法保存脚本配置")
	}
	return nil
}

func cleanKeywords(words []string) ([]string, error) {
	if len(words) > 16 {
		return nil, errors.New("每个脚本最多设置 16 个关键字")
	}
	result := []string{}
	seen := map[string]bool{}
	for _, word := range words {
		word = strings.TrimSpace(word)
		if len(word) > 120 || strings.ContainsFunc(word, unicode.IsControl) {
			return nil, errors.New("搜索关键字过长或包含控制字符")
		}
		key := strings.ToLower(word)
		if key != "" && !seen[key] {
			seen[key] = true
			result = append(result, word)
		}
	}
	return result, nil
}

func (p *plugin) commit(cfg configuration) error {
	if err := saveConfig(p.dir, cfg); err != nil {
		return err
	}
	p.cfg = cfg
	p.revision++
	p.scanned = time.Time{}
	return nil
}

func changeDirectory(dirs []string, c change) ([]string, error) {
	path, err := absolutePath(c.Path)
	if err != nil {
		return nil, err
	}
	if c.Action == "remove-directory" {
		return slices.DeleteFunc(slices.Clone(dirs), func(dir string) bool { return pathKey(dir) == pathKey(path) }), nil
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, errors.New("无法访问所选目录")
	}
	real, err = absolutePath(real)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		return nil, errors.New("请选择脚本目录")
	}
	if slices.ContainsFunc(dirs, func(dir string) bool { return pathKey(dir) == pathKey(real) }) {
		return dirs, nil
	}
	if len(dirs) >= maxLocations {
		return nil, errors.New("脚本目录数量已达上限")
	}
	return append(slices.Clone(dirs), real), nil
}

func changeEnvironment(envs []environment, c change) ([]environment, error) {
	if c.Action == "remove-environment" {
		return slices.DeleteFunc(slices.Clone(envs), func(e environment) bool { return e.ID == c.ID }), nil
	}
	path, err := absolutePath(c.Path)
	if err != nil {
		return nil, err
	}
	if !executable(path) {
		return nil, errors.New("请选择当前平台可直接运行的解释器")
	}
	name := strings.TrimSpace(c.Name)
	if name == "" || len(name) > 120 || strings.ContainsFunc(name, unicode.IsControl) {
		return nil, errors.New("请输入有效的环境名称")
	}
	if len(envs) >= maxLocations {
		return nil, errors.New("自定义环境数量已达上限")
	}
	if slices.ContainsFunc(envs, func(e environment) bool { return strings.EqualFold(e.Name, name) }) {
		return nil, errors.New("已存在同名环境")
	}
	return append(slices.Clone(envs), environment{ID: "manual-" + hash(name+"\x00"+pathKey(path)), Name: name, Path: path}), nil
}
