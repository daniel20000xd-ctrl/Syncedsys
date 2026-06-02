// A small, dependency-free spreadsheet engine: A1-style cell references,
// ranges, arithmetic, comparisons, string concat, and the core functions you'd
// use for bookkeeping. The sheet itself is stored as JSON in boards.content.

export type SheetData = { rows: number; cols: number; cells: Record<string, string> }

export const DEFAULT_ROWS = 60
export const DEFAULT_COLS = 26

export function emptySheet(): SheetData {
  return { rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: {} }
}

export function parseSheet(content: string | null | undefined): SheetData {
  if (!content) return emptySheet()
  try {
    const o = JSON.parse(content)
    if (o && typeof o === 'object' && o.cells && typeof o.cells === 'object') {
      return {
        rows: Math.max(1, Number(o.rows) || DEFAULT_ROWS),
        cols: Math.max(1, Number(o.cols) || DEFAULT_COLS),
        cells: o.cells as Record<string, string>,
      }
    }
  } catch { /* fall through */ }
  return emptySheet()
}

export function serializeSheet(d: SheetData): string {
  const cells: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.cells)) if (v !== '' && v != null) cells[k] = v
  return JSON.stringify({ rows: d.rows, cols: d.cols, cells })
}

// ── Address helpers ───────────────────────────────────────────────────────────

export function colToLetter(col: number): string {
  let s = '', n = col
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}
export function letterToCol(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}
export function cellAddr(row: number, col: number): string { return colToLetter(col) + (row + 1) }
export function parseAddr(addr: string): { row: number; col: number } | null {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(addr.trim())
  if (!m) return null
  return { col: letterToCol(m[1]), row: parseInt(m[2], 10) - 1 }
}

// ── Values ────────────────────────────────────────────────────────────────────

type CellError = { err: string }
type Val = number | string | boolean | CellError
type EvalVal = Val | Val[]

function isErr(v: unknown): v is CellError {
  return typeof v === 'object' && v !== null && 'err' in (v as Record<string, unknown>)
}

// Interpret a raw literal as a number when it looks like one ($, commas, % ok).
function literalNumber(raw: string): number | null {
  let s = raw.trim()
  if (s === '') return null
  let pct = false
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1) }
  s = s.replace(/^[$€£]/, '').replace(/,/g, '')
  if (/^-?\d*\.?\d+$/.test(s)) { const n = Number(s); return pct ? n / 100 : n }
  return null
}

function toNum(v: Val): number | CellError {
  if (isErr(v)) return v
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === '' || v == null) return 0
  const n = literalNumber(String(v))
  return n !== null ? n : { err: '#VALUE!' }
}

function toStr(v: Val): string {
  if (isErr(v)) return v.err
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v == null ? '' : String(v)
}

function truthy(v: Val): boolean {
  if (isErr(v)) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return String(v).toUpperCase() === 'TRUE'
}

function scalar(v: EvalVal): Val {
  if (Array.isArray(v)) return v.length === 1 ? v[0] : { err: '#VALUE!' }
  return v
}

function formatNumber(n: number): string {
  if (!isFinite(n)) return '#NUM!'
  const r = Math.round(n * 1e10) / 1e10
  return Number.isInteger(r) ? String(r) : String(parseFloat(r.toFixed(10)))
}

// ── Tokenizer ──────────────────────────────────────────────────────────────────

type Tok = { t: 'num' | 'str' | 'cell' | 'ident' | 'op'; v: string }

function tokenize(s: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '"') {
      let j = i + 1, str = ''
      while (j < s.length && s[j] !== '"') { str += s[j]; j++ }
      toks.push({ t: 'str', v: str }); i = j + 1; continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i, num = ''
      while (j < s.length && /[0-9.]/.test(s[j])) { num += s[j]; j++ }
      toks.push({ t: 'num', v: num }); i = j; continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i, w = ''
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) { w += s[j]; j++ }
      if (/^[A-Za-z]+[0-9]+$/.test(w)) toks.push({ t: 'cell', v: w.toUpperCase() })
      else toks.push({ t: 'ident', v: w.toUpperCase() })
      i = j; continue
    }
    const two = s.slice(i, i + 2)
    if (two === '<>' || two === '<=' || two === '>=') { toks.push({ t: 'op', v: two }); i += 2; continue }
    if ('+-*/^%&=<>(),:'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue }
    i++ // skip unknown
  }
  return toks
}

type Ctx = { getCell: (addr: string) => Val }

function collectNums(args: EvalVal[]): number[] | CellError {
  const out: number[] = []
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const el of a) {
        if (isErr(el)) return el
        if (typeof el === 'number') out.push(el)
        else if (typeof el === 'string') { const n = literalNumber(el); if (n !== null) out.push(n) }
      }
    } else {
      if (isErr(a)) return a
      const n = toNum(a)
      if (isErr(n)) return n
      out.push(n)
    }
  }
  return out
}

function callFn(name: string, args: EvalVal[], ctx: Ctx): EvalVal {
  void ctx
  const nums = () => collectNums(args)
  switch (name) {
    case 'SUM': { const n = nums(); return isErr(n) ? n : n.reduce((a, b) => a + b, 0) }
    case 'PRODUCT': { const n = nums(); return isErr(n) ? n : n.reduce((a, b) => a * b, 1) }
    case 'AVERAGE': case 'AVG': { const n = nums(); if (isErr(n)) return n; return n.length ? n.reduce((a, b) => a + b, 0) / n.length : { err: '#DIV/0!' } }
    case 'MIN': { const n = nums(); if (isErr(n)) return n; return n.length ? Math.min(...n) : 0 }
    case 'MAX': { const n = nums(); if (isErr(n)) return n; return n.length ? Math.max(...n) : 0 }
    case 'COUNT': { const n = nums(); return isErr(n) ? n : n.length }
    case 'COUNTA': {
      let c = 0
      for (const a of args) {
        if (Array.isArray(a)) { for (const el of a) if (!(el === '' || el == null)) c++ }
        else if (!(a === '' || a == null)) c++
      }
      return c
    }
    case 'IF': { const cond = scalar(args[0]); if (isErr(cond)) return cond; return truthy(cond) ? (args[1] ?? '') : (args[2] ?? false) }
    case 'AND': { for (const a of args) if (!truthy(scalar(a))) return false; return true }
    case 'OR': { for (const a of args) if (truthy(scalar(a))) return true; return false }
    case 'NOT': return !truthy(scalar(args[0]))
    case 'ROUND': { const x = toNum(scalar(args[0])); const d = toNum(scalar(args[1] ?? 0)); if (isErr(x)) return x; if (isErr(d)) return d; const f = Math.pow(10, d); return Math.round(x * f) / f }
    case 'ROUNDUP': { const x = toNum(scalar(args[0])); const d = toNum(scalar(args[1] ?? 0)); if (isErr(x)) return x; if (isErr(d)) return d; const f = Math.pow(10, d); return Math.ceil(Math.abs(x) * f) / f * Math.sign(x) }
    case 'ROUNDDOWN': { const x = toNum(scalar(args[0])); const d = toNum(scalar(args[1] ?? 0)); if (isErr(x)) return x; if (isErr(d)) return d; const f = Math.pow(10, d); return Math.floor(Math.abs(x) * f) / f * Math.sign(x) }
    case 'ABS': { const x = toNum(scalar(args[0])); return isErr(x) ? x : Math.abs(x) }
    case 'SQRT': { const x = toNum(scalar(args[0])); return isErr(x) ? x : (x < 0 ? { err: '#NUM!' } : Math.sqrt(x)) }
    case 'INT': { const x = toNum(scalar(args[0])); return isErr(x) ? x : Math.floor(x) }
    case 'FLOOR': { const x = toNum(scalar(args[0])); return isErr(x) ? x : Math.floor(x) }
    case 'CEILING': { const x = toNum(scalar(args[0])); return isErr(x) ? x : Math.ceil(x) }
    case 'MOD': { const a = toNum(scalar(args[0])); const b = toNum(scalar(args[1])); if (isErr(a)) return a; if (isErr(b)) return b; return b === 0 ? { err: '#DIV/0!' } : a % b }
    case 'POWER': { const a = toNum(scalar(args[0])); const b = toNum(scalar(args[1])); if (isErr(a)) return a; if (isErr(b)) return b; return Math.pow(a, b) }
    case 'CONCAT': case 'CONCATENATE': {
      let s = ''
      for (const a of args) { if (Array.isArray(a)) { for (const el of a) s += toStr(el) } else s += toStr(a) }
      return s
    }
    case 'ROUNDPCT': return { err: '#NAME?' }
    case 'TRUE': return true
    case 'FALSE': return false
    default: return { err: '#NAME?' }
  }
}

function evalFormula(formula: string, ctx: Ctx): Val {
  const toks = tokenize(formula)
  let pos = 0
  const peek = () => toks[pos]
  const next = () => toks[pos++]
  const eatOp = (v: string) => { const t = peek(); if (t && t.t === 'op' && t.v === v) { pos++; return true } return false }

  function arith(op: string, a: Val, b: Val): Val {
    const na = toNum(a); if (isErr(na)) return na
    const nb = toNum(b); if (isErr(nb)) return nb
    switch (op) {
      case '+': return na + nb
      case '-': return na - nb
      case '*': return na * nb
      case '/': return nb === 0 ? { err: '#DIV/0!' } : na / nb
      case '^': return Math.pow(na, nb)
    }
    return { err: '#ERR!' }
  }
  function compare(op: string, a: Val, b: Val): Val {
    if (isErr(a)) return a; if (isErr(b)) return b
    let r = 0
    if (typeof a === 'number' && typeof b === 'number') r = a < b ? -1 : a > b ? 1 : 0
    else r = toStr(a) < toStr(b) ? -1 : toStr(a) > toStr(b) ? 1 : 0
    switch (op) {
      case '=': return r === 0
      case '<>': return r !== 0
      case '<': return r < 0
      case '>': return r > 0
      case '<=': return r <= 0
      case '>=': return r >= 0
    }
    return { err: '#ERR!' }
  }

  function parseExpr(): EvalVal { return parseCompare() }
  function parseCompare(): EvalVal {
    let left = parseConcat()
    while (peek() && peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = next().v; left = compare(op, scalar(left), scalar(parseConcat()))
    }
    return left
  }
  function parseConcat(): EvalVal {
    let left = parseAdd()
    while (peek() && peek().t === 'op' && peek().v === '&') { next(); left = toStr(scalar(left)) + toStr(scalar(parseAdd())) }
    return left
  }
  function parseAdd(): EvalVal {
    let left = parseMul()
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) { const op = next().v; left = arith(op, scalar(left), scalar(parseMul())) }
    return left
  }
  function parseMul(): EvalVal {
    let left = parsePow()
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) { const op = next().v; left = arith(op, scalar(left), scalar(parsePow())) }
    return left
  }
  function parsePow(): EvalVal {
    let left = parseUnary()
    while (peek() && peek().t === 'op' && peek().v === '^') { next(); left = arith('^', scalar(left), scalar(parseUnary())) }
    return left
  }
  function parseUnary(): EvalVal {
    if (peek() && peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = next().v; const n = toNum(scalar(parseUnary())); if (isErr(n)) return n; return op === '-' ? -n : n
    }
    return parsePostfix()
  }
  function parsePostfix(): EvalVal {
    let v = parsePrimary()
    while (peek() && peek().t === 'op' && peek().v === '%') { next(); const n = toNum(scalar(v)); if (isErr(n)) return n; v = n / 100 }
    return v
  }
  function resolveRange(start: string, end: string): EvalVal {
    const a = parseAddr(start), b = parseAddr(end)
    if (!a || !b) return { err: '#REF!' }
    const out: Val[] = []
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++)
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++)
        out.push(ctx.getCell(cellAddr(r, c)))
    return out
  }
  function parsePrimary(): EvalVal {
    const t = peek()
    if (!t) return { err: '#ERR!' }
    if (t.t === 'num') { next(); return Number(t.v) }
    if (t.t === 'str') { next(); return t.v }
    if (t.t === 'ident') {
      const name = next().v
      if (peek() && peek().t === 'op' && peek().v === '(') {
        next()
        const args: EvalVal[] = []
        if (!(peek() && peek().t === 'op' && peek().v === ')')) {
          args.push(parseExpr())
          while (peek() && peek().t === 'op' && peek().v === ',') { next(); args.push(parseExpr()) }
        }
        eatOp(')')
        return callFn(name, args, ctx)
      }
      if (name === 'TRUE') return true
      if (name === 'FALSE') return false
      return { err: '#NAME?' }
    }
    if (t.t === 'cell') {
      next()
      if (peek() && peek().t === 'op' && peek().v === ':' && toks[pos + 1] && toks[pos + 1].t === 'cell') {
        next(); return resolveRange(t.v, next().v)
      }
      return ctx.getCell(t.v)
    }
    if (t.t === 'op' && t.v === '(') { next(); const v = parseExpr(); eatOp(')'); return v }
    return { err: '#ERR!' }
  }

  return scalar(parseExpr())
}

export type Computed = { value: Val; display: string }

// Compute every populated cell's value + display string, with cycle detection.
export function computeSheet(data: SheetData): Record<string, Computed> {
  const cache = new Map<string, Val>()
  const visiting = new Set<string>()
  let ctx: Ctx

  function evaluate(addr: string): Val {
    if (cache.has(addr)) return cache.get(addr)!
    const raw = data.cells[addr]
    if (raw == null || raw === '') { cache.set(addr, ''); return '' }
    if (raw[0] === '=') {
      if (visiting.has(addr)) return { err: '#CIRC!' }
      visiting.add(addr)
      let v: Val
      try { v = evalFormula(raw.slice(1), ctx) } catch { v = { err: '#ERR!' } }
      visiting.delete(addr)
      cache.set(addr, v); return v
    }
    const n = literalNumber(raw)
    const v: Val = n !== null ? n : raw
    cache.set(addr, v); return v
  }
  ctx = { getCell: evaluate }

  const out: Record<string, Computed> = {}
  for (const addr of Object.keys(data.cells)) {
    const raw = data.cells[addr]
    const v = evaluate(addr)
    out[addr] = { value: v, display: raw && raw[0] !== '=' ? raw : displayVal(v) }
  }
  return out
}

function displayVal(v: Val): string {
  if (isErr(v)) return v.err
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v == null ? '' : String(v)
}

// True numeric value of a computed cell (for the selection status bar). null if non-numeric.
export function numericValue(c: Computed | undefined): number | null {
  if (!c) return null
  if (typeof c.value === 'number') return c.value
  if (typeof c.value === 'string') return literalNumber(c.value)
  return null
}
