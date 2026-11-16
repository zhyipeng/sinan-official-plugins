// Package sdk implements bounded concurrent handlers for trusted native plugins.
package sdk

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	protocol "sinan/packages/plugin-protocol"
)

type CommandHandler func(protocol.CommandParams) (protocol.CommandResult, error)
type Handlers struct {
	HostReady  func(*HostClient)
	Initialize func(protocol.InitializeParams) error
	Command    func(context.Context, protocol.CommandParams) (protocol.CommandResult, error)
	Search     func(context.Context, protocol.SearchParams) (protocol.SearchResult, error)
}

// Serve preserves the original command-only SDK interface.
func Serve(in io.Reader, out io.Writer, pluginID string, handler CommandHandler) error {
	var commandMu sync.Mutex
	return ServeWithHandlers(in, out, pluginID, Handlers{Command: func(_ context.Context, p protocol.CommandParams) (protocol.CommandResult, error) {
		commandMu.Lock()
		defer commandMu.Unlock()
		return handler(p)
	}})
}

func ServeWithHandlers(in io.Reader, out io.Writer, pluginID string, handlers Handlers) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), protocol.MaxClipboardMessageBytes)
	encoder := json.NewEncoder(out)
	var writeMu, activeMu sync.Mutex
	active := map[uint64]context.CancelFunc{}
	host := &HostClient{pending: map[uint64]chan protocol.Response{}, sendSlots: make(chan struct{}, 4), done: make(chan struct{}), send: func(req protocol.Request) error { writeMu.Lock(); defer writeMu.Unlock(); return encoder.Encode(req) }}
	defer close(host.done)
	if handlers.HostReady != nil {
		handlers.HostReady(host)
	}
	defer func() {
		activeMu.Lock()
		defer activeMu.Unlock()
		for _, cancel := range active {
			cancel()
		}
	}()
	send := func(req protocol.Request, result any, rpcErr *protocol.Error) {
		res := protocol.Response{JSONRPC: "2.0", ID: req.ID, Error: rpcErr}
		if rpcErr == nil {
			var err error
			res.Result, err = json.Marshal(result)
			if err != nil || len(res.Result) > protocol.MaxMessageBytes/2 {
				res.Result = nil
				res.Error = &protocol.Error{Code: -32000, Message: "invalid result"}
			}
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = encoder.Encode(res)
	}
	initialized := false
	for scanner.Scan() {
		var envelope struct {
			Method string `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &envelope) != nil {
			return errors.New("invalid message")
		}
		if envelope.Method == "" {
			var response protocol.Response
			if json.Unmarshal(scanner.Bytes(), &response) != nil || response.JSONRPC != "2.0" || response.ID == 0 || (response.Error == nil) == (response.Result == nil) {
				return errors.New("invalid host response")
			}
			host.mu.Lock()
			ch := host.pending[response.ID]
			host.mu.Unlock()
			if ch != nil {
				select {
				case ch <- response:
				default:
				}
			}
			continue
		}
		if len(scanner.Bytes()) >= protocol.MaxMessageBytes {
			return errors.New("request too large")
		}
		var req protocol.Request
		if json.Unmarshal(scanner.Bytes(), &req) != nil || req.JSONRPC != "2.0" {
			return errors.New("invalid request")
		}
		if req.Method == "$/cancelRequest" && req.ID == 0 {
			var params protocol.CancelParams
			if json.Unmarshal(req.Params, &params) != nil {
				return errors.New("invalid cancellation")
			}
			activeMu.Lock()
			cancel := active[params.ID]
			activeMu.Unlock()
			if cancel != nil {
				cancel()
			}
			continue
		}
		if req.ID == 0 {
			return errors.New("invalid request id")
		}
		if req.Method == "initialize" {
			var p protocol.InitializeParams
			if initialized || json.Unmarshal(req.Params, &p) != nil || p.APIVersion != protocol.APIVersion || p.PluginID != pluginID {
				send(req, nil, &protocol.Error{Code: -32602, Message: "incompatible plugin"})
				continue
			}
			if handlers.Initialize != nil {
				if err := handlers.Initialize(p); err != nil {
					send(req, nil, &protocol.Error{Code: -32602, Message: "invalid settings"})
					continue
				}
			}
			initialized = true
			caps := []string{}
			if handlers.Search != nil {
				caps = []string{"search.query", "$/cancelRequest"}
			}
			send(req, protocol.InitializeResult{APIVersion: protocol.APIVersion, PluginID: pluginID, Capabilities: caps}, nil)
			continue
		}
		if !initialized {
			send(req, nil, &protocol.Error{Code: -32002, Message: "not initialized"})
			continue
		}
		activeMu.Lock()
		_, duplicate := active[req.ID]
		if duplicate || len(active) >= 16 {
			activeMu.Unlock()
			if duplicate {
				return errors.New("duplicate request id")
			}
			send(req, nil, &protocol.Error{Code: -32001, Message: "busy"})
			continue
		}
		ctx, cancel := context.WithCancel(context.WithValue(context.Background(), hostContextKey{}, host))
		active[req.ID] = cancel
		activeMu.Unlock()
		go func(req protocol.Request) {
			defer func() { cancel(); activeMu.Lock(); delete(active, req.ID); activeMu.Unlock() }()
			defer func() {
				if recover() != nil {
					send(req, nil, &protocol.Error{Code: -32000, Message: "handler failed"})
				}
			}()
			var result any
			var err error
			switch req.Method {
			case "command.execute":
				var p protocol.CommandParams
				if handlers.Command == nil || json.Unmarshal(req.Params, &p) != nil {
					send(req, nil, &protocol.Error{Code: -32602, Message: "invalid command"})
					return
				}
				result, err = handlers.Command(ctx, p)
			case "search.query":
				var p protocol.SearchParams
				if handlers.Search == nil || json.Unmarshal(req.Params, &p) != nil || p.Limit < 1 || p.Limit > 20 || len(p.Query) > 4096 {
					send(req, nil, &protocol.Error{Code: -32602, Message: "invalid search"})
					return
				}
				result, err = handlers.Search(ctx, p)
			default:
				send(req, nil, &protocol.Error{Code: -32601, Message: "method not found"})
				return
			}
			if ctx.Err() != nil {
				send(req, nil, &protocol.Error{Code: -32800, Message: "cancelled"})
			} else if err != nil {
				send(req, nil, &protocol.Error{Code: -32000, Message: "handler failed"})
			} else {
				send(req, result, nil)
			}
		}(req)
	}
	return scanner.Err()
}

type hostContextKey struct{}

// HostClient uses the same stdio stream; IDs are independent in each direction.
type HostClient struct {
	mu        sync.Mutex
	next      atomic.Uint64
	pending   map[uint64]chan protocol.Response
	sendSlots chan struct{}
	done      chan struct{}
	send      func(protocol.Request) error
}

func HostFromContext(ctx context.Context) *HostClient {
	h, _ := ctx.Value(hostContextKey{}).(*HostClient)
	return h
}
func (h *HostClient) ClipboardRead(ctx context.Context, sequence uint64) (protocol.ClipboardResult, error) {
	return h.clipboard(ctx, "clipboard.read", protocol.ClipboardParams{Sequence: sequence})
}
func (h *HostClient) ClipboardWrite(ctx context.Context, content protocol.ClipboardContent) error {
	_, err := h.clipboard(ctx, "clipboard.write", protocol.ClipboardParams{Content: content})
	return err
}
func (h *HostClient) clipboard(ctx context.Context, method string, params protocol.ClipboardParams) (protocol.ClipboardResult, error) {
	var result protocol.ClipboardResult
	if h == nil {
		return result, errors.New("宿主剪贴板 API 不可用")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return result, err
	}
	id := h.next.Add(1)
	ch := make(chan protocol.Response, 1)
	h.mu.Lock()
	if len(h.pending) >= 4 {
		h.mu.Unlock()
		return result, errors.New("宿主调用繁忙")
	}
	h.pending[id] = ch
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.pending, id); h.mu.Unlock() }()
	raw, err := json.Marshal(params)
	if err != nil || len(raw) > protocol.MaxClipboardMessageBytes-1024 {
		return result, errors.New("剪贴板内容超出限制")
	}
	sent := make(chan error, 1)
	select {
	case h.sendSlots <- struct{}{}:
	case <-ctx.Done():
		return result, ctx.Err()
	case <-h.done:
		return result, io.EOF
	}
	go func() {
		defer func() { <-h.sendSlots }()
		sent <- h.send(protocol.Request{JSONRPC: "2.0", ID: id, Method: method, Params: raw})
	}()
	select {
	case err = <-sent:
		if err != nil {
			return result, err
		}
	case <-ctx.Done():
		return result, ctx.Err()
	case <-h.done:
		return result, io.EOF
	}
	select {
	case response := <-ch:
		if response.Error != nil {
			return result, response.Error
		}
		err = json.Unmarshal(response.Result, &result)
		return result, err
	case <-ctx.Done():
		return result, ctx.Err()
	case <-h.done:
		return result, io.EOF
	}
}
