package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
	"sinan-official-plugins/plugins/json-tool/formatter"
)

func main() {
	if sdk.Serve(os.Stdin, os.Stdout, "tools.json", func(p protocol.CommandParams) (protocol.CommandResult, error) {
		if p.CommandID != "format" && p.CommandID != "compact" {
			return protocol.CommandResult{}, errors.New("unknown command")
		}
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		err := encoder.Encode(formatter.Format(p.Input, p.CommandID == "compact"))
		return protocol.CommandResult{Text: buffer.String()}, err
	}) != nil {
		os.Exit(1)
	}
}
