package main

import (
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode"
)

const maxExpression = 512

type calculation struct {
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
type parseError string

// A bounded grammar, never eval or a shell. Decimal arithmetic stays rational;
// transcendental functions alone use float64 (radians, 15 significant digits).
type parser struct {
	text       string
	pos, depth int
	operated   bool
}

func fail(message string) { panic(parseError(message)) }
func rational(s string) *big.Rat {
	// SetString treats an integer with a leading zero as octal. Decimal
	// notation forces the same base-10 semantics as the page parser.
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	v, ok := new(big.Rat).SetString(s)
	if !ok {
		fail("数字格式不正确")
	}
	return v
}
func bounded(v *big.Rat) *big.Rat {
	if v.Num().BitLen() > 2048 || v.Denom().BitLen() > 2048 {
		fail("计算超出范围")
	}
	return v
}
func floating(v float64) *big.Rat {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		fail("结果不在实数范围内或超出范围")
	}
	return rational(strconv.FormatFloat(v, 'g', 15, 64))
}
func (p *parser) skip() {
	for p.pos < len(p.text) && p.text[p.pos] == ' ' {
		p.pos++
	}
}
func (p *parser) eat(c byte) bool {
	p.skip()
	if p.pos < len(p.text) && p.text[p.pos] == c {
		p.pos++
		return true
	}
	return false
}
func (p *parser) expression() *big.Rat {
	p.depth++
	if p.depth > 64 {
		fail("括号或运算嵌套过深")
	}
	defer func() { p.depth-- }()
	v := p.product()
	for {
		if p.eat('+') {
			p.operated = true
			v = bounded(new(big.Rat).Add(v, p.product()))
		} else if p.eat('-') {
			p.operated = true
			v = bounded(new(big.Rat).Sub(v, p.product()))
		} else {
			return v
		}
	}
}
func (p *parser) product() *big.Rat {
	v := p.unary()
	for {
		if p.eat('*') {
			p.operated = true
			v = bounded(new(big.Rat).Mul(v, p.unary()))
		} else if p.eat('/') {
			p.operated = true
			d := p.unary()
			if d.Sign() == 0 {
				fail("不能除以零")
			}
			v = bounded(new(big.Rat).Quo(v, d))
		} else {
			return v
		}
	}
}
func (p *parser) unary() *big.Rat {
	p.depth++
	if p.depth > 64 {
		fail("运算嵌套过深")
	}
	defer func() { p.depth-- }()
	if p.eat('+') {
		return p.unary()
	}
	if p.eat('-') {
		return new(big.Rat).Neg(p.unary())
	}
	return p.power()
}
func (p *parser) power() *big.Rat {
	v := p.atom()
	for p.eat('%') {
		p.operated = true
		v = bounded(new(big.Rat).Quo(v, big.NewRat(100, 1)))
	}
	if p.eat('^') {
		p.operated = true
		e := p.unary()
		if e.IsInt() && e.Num().IsInt64() {
			n := e.Num().Int64()
			if n > 1000 || n < -1000 {
				fail("指数超出范围")
			}
			if v.Sign() == 0 && n < 0 {
				fail("不能除以零")
			}
			if n < 0 {
				v = new(big.Rat).Inv(v)
				n = -n
			}
			if int64(v.Num().BitLen())*n > 4096 || int64(v.Denom().BitLen())*n > 4096 {
				fail("计算超出范围")
			}
			v = bounded(new(big.Rat).SetFrac(new(big.Int).Exp(v.Num(), big.NewInt(n), nil), new(big.Int).Exp(v.Denom(), big.NewInt(n), nil)))
		} else {
			a, _ := v.Float64()
			b, _ := e.Float64()
			v = floating(math.Pow(a, b))
		}
	}
	return v
}
func (p *parser) atom() *big.Rat {
	p.skip()
	if p.eat('(') {
		v := p.expression()
		if !p.eat(')') {
			fail("缺少右括号")
		}
		return v
	}
	start := p.pos
	for p.pos < len(p.text) && p.text[p.pos] >= 'a' && p.text[p.pos] <= 'z' {
		p.pos++
	}
	if p.pos > start {
		name := p.text[start:p.pos]
		if name == "pi" {
			p.operated = true
			return floating(math.Pi)
		}
		if name == "e" {
			p.operated = true
			return floating(math.E)
		}
		if !p.eat('(') {
			fail("不支持的名称或缺少左括号")
		}
		p.operated = true
		args := []*big.Rat{p.expression()}
		for p.eat(',') {
			if len(args) >= 16 {
				fail("函数参数过多")
			}
			args = append(args, p.expression())
		}
		if !p.eat(')') {
			fail("缺少右括号")
		}
		return function(name, args)
	}
	digits := 0
	for p.pos < len(p.text) && p.text[p.pos] >= '0' && p.text[p.pos] <= '9' {
		p.pos++
		digits++
	}
	if p.pos < len(p.text) && p.text[p.pos] == '.' {
		p.pos++
		for p.pos < len(p.text) && p.text[p.pos] >= '0' && p.text[p.pos] <= '9' {
			p.pos++
			digits++
		}
	}
	if digits == 0 {
		fail("请输入完整的计算表达式")
	}
	if p.pos < len(p.text) && p.text[p.pos] == 'e' {
		p.pos++
		if p.pos < len(p.text) && (p.text[p.pos] == '+' || p.text[p.pos] == '-') {
			p.pos++
		}
		expStart := p.pos
		for p.pos < len(p.text) && p.text[p.pos] >= '0' && p.text[p.pos] <= '9' {
			p.pos++
		}
		exp, err := strconv.Atoi(p.text[expStart:p.pos])
		if err != nil || exp > 300 {
			fail("科学计数法指数超出范围")
		}
	}
	return bounded(rational(p.text[start:p.pos]))
}
func function(name string, args []*big.Rat) *big.Rat {
	if name == "min" || name == "max" {
		v := args[0]
		for _, a := range args[1:] {
			if name == "min" && a.Cmp(v) < 0 || name == "max" && a.Cmp(v) > 0 {
				v = a
			}
		}
		return v
	}
	if len(args) != 1 {
		fail("函数需要一个参数")
	}
	a := args[0]
	if name == "round" || name == "floor" || name == "ceil" {
		q, r := new(big.Int), new(big.Int)
		q.QuoRem(a.Num(), a.Denom(), r)
		if name == "floor" && r.Sign() < 0 {
			q.Sub(q, big.NewInt(1))
		}
		if name == "ceil" && r.Sign() > 0 {
			q.Add(q, big.NewInt(1))
		}
		if name == "round" && new(big.Int).Mul(new(big.Int).Abs(r), big.NewInt(2)).Cmp(a.Denom()) >= 0 {
			q.Add(q, big.NewInt(int64(a.Sign())))
		}
		return new(big.Rat).SetInt(q)
	}
	v, _ := a.Float64()
	switch name {
	case "abs":
		return new(big.Rat).Abs(a)
	case "sqrt":
		return floating(math.Sqrt(v))
	case "sin":
		return floating(math.Sin(v))
	case "cos":
		return floating(math.Cos(v))
	case "tan":
		return floating(math.Tan(v))
	case "ln":
		return floating(math.Log(v))
	case "log":
		return floating(math.Log10(v))
	case "round":
		return floating(math.Round(v))
	case "floor":
		return floating(math.Floor(v))
	case "ceil":
		return floating(math.Ceil(v))
	}
	fail("不支持的函数")
	return nil
}
func format(v *big.Rat) string {
	if v.Sign() == 0 {
		return "0"
	}
	if v.IsInt() {
		return v.Num().String()
	}
	// Exact finite decimals up to 100 fractional places; recurring fractions round
	// to 15 significant digits rather than exposing binary floating point noise.
	d := new(big.Int).Set(v.Denom())
	two, five := 0, 0
	for d.Bit(0) == 0 {
		d.Rsh(d, 1)
		two++
	}
	q, r := new(big.Int), new(big.Int)
	for {
		q.QuoRem(d, big.NewInt(5), r)
		if r.Sign() != 0 {
			break
		}
		d.Set(q)
		five++
	}
	if d.Cmp(big.NewInt(1)) == 0 && max(two, five) <= 100 {
		return strings.TrimRight(strings.TrimRight(v.FloatString(max(two, five)), "0"), ".")
	}
	f := new(big.Float).SetPrec(256).SetRat(v)
	return f.Text('g', 15)
}
func evaluate(text string, search bool) (out calculation) {
	defer func() {
		if err := recover(); err != nil {
			if message, ok := err.(parseError); ok {
				out = calculation{Error: string(message)}
			} else {
				panic(err)
			}
		}
	}()
	if len(text) > maxExpression {
		fail("表达式最多 512 字节")
	}
	text = strings.Map(func(r rune) rune {
		switch r {
		case '×', 'ｘ':
			return '*'
		case '÷':
			return '/'
		case '−', '－':
			return '-'
		case '＋':
			return '+'
		case '（':
			return '('
		case '）':
			return ')'
		case '％':
			return '%'
		case 'π':
			return 'p'
		}
		if unicode.IsSpace(r) {
			return ' '
		}
		return unicode.ToLower(r)
	}, strings.ReplaceAll(text, "π", "pi"))
	text = strings.TrimSpace(text)
	text = strings.TrimSpace(strings.TrimSuffix(text, "="))
	if text == "" {
		return calculation{}
	}
	p := parser{text: text}
	v := p.expression()
	p.skip()
	if p.pos != len(text) {
		fail("含有不支持的字符或缺少运算符")
	}
	if search && !p.operated {
		return calculation{}
	}
	return calculation{Result: format(v)}
}
