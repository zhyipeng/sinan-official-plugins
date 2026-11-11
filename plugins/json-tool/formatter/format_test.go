package formatter

import (
	"strings"
	"testing"
)

func TestFormattingPreservesNumbersOrderAndStrings(t *testing.T) {
	input := `{"z":900719925474099312345,"a":1.2300e+99,"text":"中文\\n"}`
	result := Format(input, false)
	if result.Error != "" || !strings.Contains(result.Output, "900719925474099312345") || !strings.Contains(result.Output, "1.2300e+99") {
		t.Fatal("number changed")
	}
	compact := Format(result.Output, true)
	if compact.Error != "" || compact.Output != input {
		t.Fatal("round trip changed text")
	}
	for _, input := range []string{"", `{"x":}`, "{} {}"} {
		if Format(input, false).Error == "" {
			t.Fatal("invalid JSON accepted")
		}
	}
	if result = Format("{\n  \"x\": }", false); result.Line != 2 || result.Column != 8 {
		t.Fatal("incorrect error location", result.Line, result.Column)
	}
	if Format(strings.Repeat("[", 129)+strings.Repeat("]", 129), false).Error == "" {
		t.Fatal("deep document accepted")
	}
	if Format(`"`+strings.Repeat("x", MaxInputBytes)+`"`, false).Error == "" {
		t.Fatal("oversized input accepted")
	}
	if Format(strings.Repeat("[", 120)+strings.Repeat("0,", 5000)+"0"+strings.Repeat("]", 120), false).Error == "" {
		t.Fatal("oversized output accepted")
	}
}
