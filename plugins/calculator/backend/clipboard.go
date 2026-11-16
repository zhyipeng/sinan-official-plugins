package main

import (
	"context"
	protocol "sinan/packages/plugin-protocol"
	sdk "sinan/packages/plugin-sdk"
)

func copyText(ctx context.Context, text string) error {
	return sdk.HostFromContext(ctx).ClipboardWrite(ctx, protocol.ClipboardContent{Kind: "text", Data: []byte(text)})
}
