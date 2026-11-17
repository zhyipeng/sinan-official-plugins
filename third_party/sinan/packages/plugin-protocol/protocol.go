// Package protocol defines the language-neutral v1 plugin wire contract.
package protocol

import "encoding/json"

const APIVersion = "1"
const MaxMessageBytes = 1 << 20

// Only clipboard host RPC may use this budget (8 MiB PNG encoded as base64).
const MaxClipboardMessageBytes = 12 << 20
const ClipboardCapability = "clipboard.v1"
const WindowExecuteCapability = "ui.window-execute.v1"
const ImageOutputCapability = "ui.image-output.v1"
const ImageInputCapability = "ui.image-input.v1"

// Image commands carry a host-validated, session-owned PNG (at most 4 MiB).
const ImageCommandCapability = "ui.image-command.v1"
const MaxImageCommandBytes = 6 << 20

type ClipboardContent struct {
	Kind string `json:"kind"`
	Data []byte `json:"data"`
}
type ClipboardParams struct {
	Sequence uint64           `json:"sequence,omitempty"`
	Content  ClipboardContent `json:"content,omitempty"`
}
type ClipboardResult struct {
	Content  ClipboardContent `json:"content"`
	Sequence uint64           `json:"sequence"`
}

type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

type InitializeParams struct {
	HostCapabilities []string            `json:"hostCapabilities,omitempty"`
	Settings         map[string][]string `json:"settings,omitempty"`
	APIVersion       string              `json:"apiVersion"`
	PluginID         string              `json:"pluginId"`
	DataDir          string              `json:"dataDir,omitempty"`
	CacheDir         string              `json:"cacheDir,omitempty"`
}

type InitializeResult struct {
	APIVersion   string   `json:"apiVersion"`
	PluginID     string   `json:"pluginId"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type CommandParams struct {
	Image     []byte `json:"image,omitempty"`
	CommandID string `json:"commandId"`
	Input     string `json:"input"`
}

type CommandResult struct {
	Text       string `json:"text"`
	Dismiss    bool   `json:"dismiss,omitempty"`
	KeepHidden bool   `json:"keepHidden,omitempty"`
}

type CancelParams struct {
	ID uint64 `json:"id"`
}

type SearchParams struct {
	ProviderID string `json:"providerId"`
	Query      string `json:"query"`
	Limit      int    `json:"limit"`
}

type SearchItem struct {
	Icon      string  `json:"icon,omitempty"`
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Subtitle  string  `json:"subtitle,omitempty"`
	CommandID string  `json:"commandId"`
	Input     string  `json:"input,omitempty"`
	Score     float64 `json:"score"`
}

type SearchResult struct {
	Items []SearchItem `json:"items"`
}
