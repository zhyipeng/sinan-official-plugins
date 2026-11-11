// Package sdk implements bounded concurrent handlers for trusted native plugins.
package sdk

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"

	protocol "sinan/packages/plugin-protocol"
)

type CommandHandler func(protocol.CommandParams) (protocol.CommandResult, error)
type Handlers struct {
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
	scanner.Buffer(make([]byte, 4096), protocol.MaxMessageBytes)
	encoder := json.NewEncoder(out)
	var writeMu, activeMu sync.Mutex
	active := map[uint64]context.CancelFunc{}
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
		ctx, cancel := context.WithCancel(context.Background())
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
