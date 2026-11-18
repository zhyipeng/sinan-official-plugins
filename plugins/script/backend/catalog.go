package main

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type script struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Exists   bool     `json:"exists"`
	Resolved string   `json:"resolved"`
	Status   runState `json:"status,omitempty"`
	ResultID string   `json:"resultId,omitempty"`
	Delivery string   `json:"delivery,omitempty"`
	override
}

type catalog struct {
	scripts []script
	missing int
	limited bool
}

func hash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func scriptKind(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".py":
		return "python"
	case ".js":
		return "node"
	case ".sh":
		return "sh"
	}
	return ""
}

func newScript(path string, cfg configuration, exists bool) script {
	key := pathKey(path)
	options := cfg.Scripts[key]
	options.Path = path
	return script{ID: hash(key), Name: filepath.Base(path), Exists: exists, override: options}
}

func scan(ctx context.Context, cfg configuration) (catalog, error) {
	const maxEntries = 50_000
	const maxScripts = 10_000
	found := map[string]script{}
	index := catalog{}
	for key, item := range cfg.Scripts {
		if item.Imported {
			info, err := os.Stat(item.Path)
			found[key] = newScript(item.Path, cfg, err == nil && info.Mode().IsRegular())
		}
	}
	visited := 0
	for _, dir := range cfg.Directories {
		if index.limited {
			break
		}
		root, err := os.OpenRoot(dir)
		if err != nil {
			index.missing++
			continue
		}
		folder, err := root.Open(".")
		root.Close()
		if err != nil {
			index.missing++
			continue
		}
		for {
			if err := ctx.Err(); err != nil {
				folder.Close()
				return catalog{}, err
			}
			entries, err := folder.ReadDir(128)
			for _, entry := range entries {
				visited++
				if visited > maxEntries || len(found) >= maxScripts {
					index.limited = true
					break
				}
				if !entry.Type().IsRegular() || scriptKind(entry.Name()) == "" {
					continue
				}
				path, err := absolutePath(filepath.Join(dir, entry.Name()))
				if err != nil {
					continue
				}
				key := pathKey(path)
				if _, exists := found[key]; !exists {
					found[key] = newScript(path, cfg, true)
				}
			}
			if err != nil && err != io.EOF {
				index.missing++
			}
			if err != nil || index.limited {
				break
			}
		}
		folder.Close()
	}
	index.scripts = slices.SortedFunc(maps.Values(found), func(a, b script) int {
		return cmp.Or(strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), strings.Compare(a.Path, b.Path))
	})
	return index, ctx.Err()
}

func (p *plugin) index(ctx context.Context) (catalog, uint64, error) {
	for {
		p.mu.RLock()
		if time.Since(p.scanned) < 2*time.Second {
			cached, rev := p.cached, p.revision
			p.mu.RUnlock()
			return cached, rev, nil
		}
		p.mu.RUnlock()

		select {
		case p.scanning <- struct{}{}:
		case <-ctx.Done():
			return catalog{}, 0, ctx.Err()
		}
		p.mu.RLock()
		cfg, rev, cached, fresh := p.cfg, p.revision, p.cached, time.Since(p.scanned) < 2*time.Second
		p.mu.RUnlock()
		if fresh {
			<-p.scanning
			return cached, rev, nil
		}
		cached, err := scan(ctx, cfg)
		p.mu.Lock()
		current := rev == p.revision
		if current && err == nil {
			p.cached, p.scanned = cached, time.Now()
		}
		p.mu.Unlock()
		<-p.scanning
		if current || err != nil {
			return cached, rev, err
		}
	}
}

func discover() []environment {
	names := []string{"python2", "python3", "python", "node", "sh"}
	envs := make([]environment, 0, len(names))
	directories := filepath.SplitList(os.Getenv("PATH"))
	for _, name := range names {
		binary := name
		if runtime.GOOS == "windows" {
			binary += ".exe"
		}
		for _, dir := range directories {
			if !filepath.IsAbs(dir) {
				continue
			}
			path, err := absolutePath(filepath.Join(dir, binary))
			if err == nil && executable(path) {
				envs = append(envs, environment{ID: "path-" + name, Name: name, Path: path})
				break
			}
		}
	}
	if runtime.GOOS != "windows" && !slices.ContainsFunc(envs, func(e environment) bool { return e.ID == "path-sh" }) && executable("/bin/sh") {
		envs = append(envs, environment{ID: "path-sh", Name: "sh", Path: "/bin/sh"})
	}
	return envs
}

func interpreter(item script, envs []environment) (environment, error) {
	id := item.Environment
	if id == direct || (id == "" && scriptKind(item.Path) == "") {
		return environment{ID: direct, Name: "直接执行", Path: item.Path}, nil
	}
	var choices []string
	switch {
	case id != "":
		choices = []string{id}
	case scriptKind(item.Path) == "python":
		if version := pythonShebang(item.Path); version != "" {
			choices = []string{"path-" + version}
		} else {
			choices = []string{"path-python3", "path-python", "path-python2"}
		}
	default:
		choices = []string{"path-" + scriptKind(item.Path)}
	}
	for _, choice := range choices {
		if i := slices.IndexFunc(envs, func(e environment) bool { return e.ID == choice }); i >= 0 {
			return envs[i], nil
		}
	}
	return environment{}, errEnvironment
}

func pythonShebang(path string) string {
	file, err := openScriptHeader(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	var prefix [256]byte
	n, _ := file.Read(prefix[:])
	line, _, _ := strings.Cut(string(prefix[:n]), "\n")
	if !strings.HasPrefix(line, "#!") {
		return ""
	}
	fields := strings.Fields(line[2:])
	if len(fields) == 0 {
		return ""
	}
	name := filepath.Base(fields[0])
	if name == "env" {
		fields = fields[1:]
		if len(fields) > 0 && fields[0] == "-S" {
			fields = fields[1:]
		}
		if len(fields) == 0 {
			return ""
		}
		name = fields[0]
	}
	name = strings.TrimSuffix(name, ".exe")
	for _, version := range []string{"python2", "python3"} {
		if name == version || strings.HasPrefix(name, version+".") {
			return version
		}
	}
	return ""
}

func match(item script, query string) float64 {
	name := strings.ToLower(item.Name)
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	if query == "" || query == name || query == stem {
		return 1
	}
	score := 0.0
	if strings.HasPrefix(name, query) {
		score = .87
	} else if strings.Contains(name, query) {
		score = .69
	}
	for _, word := range item.Keywords {
		word = strings.ToLower(word)
		switch {
		case word == query:
			return .97
		case strings.HasPrefix(word, query):
			score = max(score, .83)
		case strings.Contains(word, query):
			score = max(score, .64)
		}
	}
	return score
}

func searchTitle(name string) string {
	title := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	if len(title) <= 256 {
		return title
	}
	end := 253
	for !utf8.RuneStart(title[end]) {
		end--
	}
	return title[:end] + "…"
}
