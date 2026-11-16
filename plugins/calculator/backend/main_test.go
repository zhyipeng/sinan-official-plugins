package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	protocol "sinan/packages/plugin-protocol"
	"strings"
	"testing"
)

func TestExpressions(t *testing.T) {
	b, err := os.ReadFile("../tests/expressions.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Input, Result string
		Error, Empty  bool
		Search        *bool
	}
	if err = json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Input, func(t *testing.T) {
			got := evaluate(c.Input, false)
			if c.Error {
				if got.Error == "" {
					t.Fatalf("expected error, got %#v", got)
				}
			} else if got.Error != "" || got.Result != c.Result {
				t.Fatalf("got %#v, want %s", got, c.Result)
			}
			result, err := search(context.Background(), protocol.SearchParams{ProviderID: "expressions", Query: c.Input, Limit: 1})
			want := !c.Error && !c.Empty && (c.Search == nil || *c.Search)
			if err != nil || (len(result.Items) == 1) != want {
				t.Fatalf("search %#v, %v", result, err)
			}
			if want {
				item := result.Items[0]
				if item.Title != c.Result || item.Input != c.Input || item.CommandID != "copy" {
					t.Fatalf("incorrect result %#v", item)
				}
			}
		})
	}
}
func TestBudgets(t *testing.T) {
	for _, s := range []string{strings.Repeat("(", 80) + "1" + strings.Repeat(")", 80), strings.Repeat("-", 90) + "1", strings.Repeat("1", 513), "(2^1000)^1000"} {
		if evaluate(s, false).Error == "" {
			t.Fatal("budget accepted")
		}
	}
}
func TestCopyRecalculatesAndPropagatesFailure(t *testing.T) {
	called := false
	copy := func(_ context.Context, text string) error {
		called = true
		if text != "0.3" {
			t.Fatal(text)
		}
		return nil
	}
	r, err := handleCommand(context.Background(), protocol.CommandParams{CommandID: "copy", Input: "0.1+0.2"}, copy)
	if err != nil || !r.Dismiss || !called {
		t.Fatalf("%#v %v", r, err)
	}
	called = false
	if _, err = handleCommand(context.Background(), protocol.CommandParams{CommandID: "copy", Input: "not an expression"}, copy); err == nil || called {
		t.Fatal("invalid expression copied")
	}
	if _, err = handleCommand(context.Background(), protocol.CommandParams{CommandID: "copy", Input: "1+1"}, func(context.Context, string) error { return errors.New("unavailable") }); err == nil {
		t.Fatal("copy failure swallowed")
	}
}
func TestBatchAndCancellation(t *testing.T) {
	r, err := handleCommand(context.Background(), protocol.CommandParams{CommandID: "evaluate", Input: `["1+2","1/0",""]`}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var rows []calculation
	if json.Unmarshal([]byte(r.Text), &rows) != nil || len(rows) != 3 || rows[0].Result != "3" || rows[1].Error == "" || rows[2].Result != "" {
		t.Fatal(r)
	}
	if _, err = handleCommand(context.Background(), protocol.CommandParams{CommandID: "evaluate", Input: `{}`}, nil); err == nil {
		t.Fatal("invalid batch accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = search(ctx, protocol.SearchParams{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
