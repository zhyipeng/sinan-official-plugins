package formatter

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

const MaxInputBytes = 48 << 10
const MaxOutputBytes = 128 << 10

type Result struct {
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

// Work directly on JSON text: number spelling, precision and object order survive.
func Format(input string, compact bool) Result {
	if len(input) > MaxInputBytes {
		return Result{Error: "输入超过 48 KiB"}
	}
	data := []byte(input)
	if !json.Valid(data) {
		var value json.RawMessage
		err := json.Unmarshal(data, &value)
		result := Result{Error: "JSON 格式错误", Line: 1, Column: 1}
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			offset := int(syntax.Offset) - 1
			if offset > len(data) {
				offset = len(data)
			}
			for _, r := range string(data[:max(0, offset)]) {
				if r == '\n' {
					result.Line++
					result.Column = 1
				} else {
					result.Column++
				}
			}
		}
		return result
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	depth := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Result{Error: "JSON 格式错误"}
		}
		if delim, ok := token.(json.Delim); ok {
			if delim == '{' || delim == '[' {
				depth++
			} else {
				depth--
			}
			if depth > 128 {
				return Result{Error: "JSON 嵌套超过 128 层"}
			}
		}
	}
	var out bytes.Buffer
	var err error
	if compact {
		err = json.Compact(&out, data)
	} else {
		err = json.Indent(&out, data, "", "  ")
	}
	if err != nil {
		return Result{Error: "JSON 格式错误"}
	}
	if out.Len() > MaxOutputBytes {
		return Result{Error: "格式化结果超过 128 KiB"}
	}
	return Result{Output: out.String()}
}
