'use client'

import * as React from 'react'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  Loader2, Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, Plus,
} from 'lucide-react'
import { getGoogleConnectionStatus } from '@/app/actions'

// A fully interactive Google Sheets viewer/editor in a portal frame. Talks to the
// local /api/google/sheets routes (browser cookie session). Virtualized grid so
// large sheets stay fast; selection, in-cell editing with write-back, a formula
// bar, a formatting toolbar (batchUpdate), and a right-click structural menu.

type ViewerConfig = { spreadsheetId?: string; activeSheet?: string }

interface Props {
  config: ViewerConfig
  onPersistConfig: (c: ViewerConfig) => void
  onUpdateContext?: (ctx: string) => void
}

type SheetTab = {
  sheetId: number
  title: string
  index: number
  rowCount: number
  columnCount: number
  frozenRowCount: number
  frozenColumnCount: number
}
type SpreadsheetMeta = { title: string; sheets: SheetTab[] }
type CellFmt = { bold?: boolean; italic?: boolean; underline?: boolean; color?: string; bg?: string; align?: 'LEFT' | 'CENTER' | 'RIGHT' }
type Sel = { ar: number; ac: number; fr: number; fc: number }

const ROW_H = 24
const HEADER_H = 22
const ROWNUM_W = 46
const DEFAULT_COL_W = 88
const MIN_COL_W = 40
const BUFFER = 20

function parseSpreadsheetId(input: string): string | null {
  const t = input.trim()
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (m) return m[1]
  if (/^[a-zA-Z0-9-_]{20,}$/.test(t)) return t
  return null
}

function colName(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

const a1 = (r: number, c: number) => `${colName(c)}${r + 1}`
const sheetRange = (title: string, ref: string) => `'${title.replace(/'/g, "''")}'!${ref}`

function norm(sel: Sel) {
  return {
    r0: Math.min(sel.ar, sel.fr), r1: Math.max(sel.ar, sel.fr),
    c0: Math.min(sel.ac, sel.fc), c1: Math.max(sel.ac, sel.fc),
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] overflow-hidden text-white flex flex-col"
      onPointerDown={e => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

export default function GoogleSheetsPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [meta, setMeta] = useState<SpreadsheetMeta | null>(null)
  const [activeTitle, setActiveTitle] = useState<string | null>(null)
  const [values, setValues] = useState<string[][]>([])
  const [formats, setFormats] = useState<Map<string, CellFmt>>(new Map())
  const [sel, setSel] = useState<Sel>({ ar: 0, ac: 0, fr: 0, fc: 0 })
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [colWidths, setColWidths] = useState<number[]>([])
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(360)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const onContextRef = useRef(onUpdateContext)
  useEffect(() => { onContextRef.current = onUpdateContext }, [onUpdateContext])

  const scrollRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const resizeRef = useRef<{ col: number; startX: number; startW: number } | null>(null)

  const spreadsheetId = config.spreadsheetId || null
  const activeSheet = meta?.sheets.find(s => s.title === activeTitle) ?? null

  // ── Connection check ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancel = false
    getGoogleConnectionStatus()
      .then(s => { if (!cancel) setConnected(s.connected) })
      .catch(() => { if (!cancel) setConnected(false) })
    return () => { cancel = true }
  }, [])

  // ── Load metadata + first sheet whenever the spreadsheet changes ───────────
  const loadValues = useCallback(async (spId: string, title: string) => {
    setLoading(true)
    const range = `'${title.replace(/'/g, "''")}'` // whole sheet by name
    try {
      const res = await fetch(`/api/google/sheets?spreadsheetId=${encodeURIComponent(spId)}&range=${encodeURIComponent(range)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Failed to read sheet (${res.status})`)
      const data = (await res.json()) as { values?: string[][] }
      setValues(data.values ?? [])
      setFormats(new Map())
      setSel({ ar: 0, ac: 0, fr: 0, fc: 0 })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sheet')
    } finally {
      setLoading(false)
    }
    // Push a fresh Claude context summary (fire and forget).
    fetch(`/api/google/sheets/context?spreadsheetId=${encodeURIComponent(spId)}&sheet=${encodeURIComponent(title)}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.text() : null))
      .then(t => { if (t) onContextRef.current?.(t) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!connected || !spreadsheetId) return
    let cancel = false
    setLoading(true)
    fetch(`/api/google/sheets/metadata?spreadsheetId=${encodeURIComponent(spreadsheetId)}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`Metadata failed (${r.status})`))))
      .then((m: SpreadsheetMeta) => {
        if (cancel) return
        setMeta(m)
        const title = (config.activeSheet && m.sheets.some(s => s.title === config.activeSheet) ? config.activeSheet : m.sheets[0]?.title) ?? null
        setActiveTitle(title)
        if (title) loadValues(spreadsheetId, title)
        else setLoading(false)
      })
      .catch(e => { if (!cancel) { setError(e instanceof Error ? e.message : 'Failed to open spreadsheet'); setLoading(false) } })
    return () => { cancel = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, spreadsheetId])

  // ── Derived grid dimensions ────────────────────────────────────────────────
  const colCount = useMemo(() => {
    const maxLen = values.reduce((m, row) => Math.max(m, row.length), 0)
    return Math.min(50, Math.max(26, maxLen + 2))
  }, [values])
  const totalRows = useMemo(() => Math.min(5000, Math.max(60, values.length + 30)), [values])

  // Keep colWidths sized to colCount (preserving existing widths).
  useEffect(() => {
    setColWidths(prev => {
      if (prev.length === colCount) return prev
      const next = prev.slice(0, colCount)
      while (next.length < colCount) next.push(DEFAULT_COL_W)
      return next
    })
  }, [colCount])

  const colOffsets = useMemo(() => {
    const offs: number[] = [ROWNUM_W]
    for (let i = 0; i < colWidths.length; i++) offs.push(offs[i] + colWidths[i])
    return offs
  }, [colWidths])
  const totalWidth = colOffsets[colOffsets.length - 1] ?? ROWNUM_W

  // Re-measure the viewport for virtualization (portal is resizable).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    setViewportH(el.clientHeight)
    return () => ro.disconnect()
  }, [spreadsheetId, activeTitle])

  // Global listeners for drag-select, column resize.
  useEffect(() => {
    function up() { draggingRef.current = false; resizeRef.current = null }
    function move(e: MouseEvent) {
      const rz = resizeRef.current
      if (!rz) return
      const w = Math.max(MIN_COL_W, rz.startW + (e.clientX - rz.startX))
      setColWidths(prev => { const n = [...prev]; n[rz.col] = w; return n })
    }
    window.addEventListener('mouseup', up)
    window.addEventListener('mousemove', move)
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('mousemove', move) }
  }, [])

  const cellValue = (r: number, c: number) => values[r]?.[c] ?? ''
  const fmtAt = (r: number, c: number) => formats.get(`${r}:${c}`) ?? {}

  // ── Writes ─────────────────────────────────────────────────────────────────
  const writeCell = useCallback(async (r: number, c: number, value: string) => {
    if (!spreadsheetId || !activeTitle) return
    setValues(prev => {
      const next = prev.map(row => row.slice())
      while (next.length <= r) next.push([])
      const row = next[r]
      while (row.length <= c) row.push('')
      row[c] = value
      return next
    })
    try {
      const res = await fetch('/api/google/sheets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId, range: sheetRange(activeTitle, a1(r, c)), values: [[value]] }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setError('Could not save cell')
    }
  }, [spreadsheetId, activeTitle])

  function beginEdit(r: number, c: number, initial?: string) {
    setEditing({ r, c })
    setEditValue(initial ?? cellValue(r, c))
  }
  function commitEdit(move: 'down' | 'right' | null) {
    if (!editing) return
    const { r, c } = editing
    writeCell(r, c, editValue)
    setEditing(null)
    if (move === 'down') setFocus(r + 1, c, false)
    else if (move === 'right') setFocus(r, c + 1, false)
  }

  function setFocus(r: number, c: number, extend: boolean) {
    const rr = Math.max(0, Math.min(totalRows - 1, r))
    const cc = Math.max(0, Math.min(colCount - 1, c))
    setSel(prev => extend ? { ...prev, fr: rr, fc: cc } : { ar: rr, ac: cc, fr: rr, fc: cc })
    // scroll into view (vertical)
    const el = scrollRef.current
    if (el) {
      const top = rr * ROW_H
      const frozenH = HEADER_H + (Math.min(activeSheet?.frozenRowCount ?? 0, 3)) * ROW_H
      if (top < el.scrollTop + frozenH) el.scrollTop = Math.max(0, top - frozenH)
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  function onGridKeyDown(e: React.KeyboardEvent) {
    if (editing) return // the cell input handles its own keys
    if (menu) setMenu(null)
    const { fr, fc } = sel
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(fr - 1, fc, e.shiftKey) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(fr + 1, fc, e.shiftKey) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setFocus(fr, fc - 1, e.shiftKey) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setFocus(fr, fc + 1, e.shiftKey) }
    else if (e.key === 'Tab') { e.preventDefault(); setFocus(fr, fc + (e.shiftKey ? -1 : 1), false) }
    else if (e.key === 'Enter') { e.preventDefault(); beginEdit(fr, fc) }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); clearSelection() }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { beginEdit(fr, fc, e.key) }
  }

  async function clearSelection() {
    const { r0, r1, c0, c1 } = norm(sel)
    setValues(prev => {
      const next = prev.map(row => row.slice())
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (next[r]) next[r][c] = ''
      return next
    })
    if (!spreadsheetId || !activeTitle) return
    try {
      await fetch('/api/google/sheets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spreadsheetId,
          range: sheetRange(activeTitle, `${a1(r0, c0)}:${a1(r1, c1)}`),
          values: Array.from({ length: r1 - r0 + 1 }, () => Array.from({ length: c1 - c0 + 1 }, () => '')),
        }),
      })
    } catch { setError('Could not clear cells') }
  }

  // ── Cell mouse interactions ────────────────────────────────────────────────
  function onCellMouseDown(e: React.MouseEvent, r: number, c: number) {
    if (e.button === 2) return // context menu handler deals with right-click
    if (editing) commitEdit(null)
    scrollRef.current?.focus()
    if (e.shiftKey) setSel(prev => ({ ...prev, fr: r, fc: c }))
    else { setSel({ ar: r, ac: c, fr: r, fc: c }); draggingRef.current = true }
  }
  function onCellMouseEnter(r: number, c: number) {
    if (draggingRef.current) setSel(prev => ({ ...prev, fr: r, fc: c }))
  }
  function onCellContextMenu(e: React.MouseEvent, r: number, c: number) {
    e.preventDefault()
    const { r0, r1, c0, c1 } = norm(sel)
    if (r < r0 || r > r1 || c < c0 || c > c1) setSel({ ar: r, ac: c, fr: r, fc: c })
    const host = scrollRef.current?.getBoundingClientRect()
    setMenu({ x: e.clientX - (host?.left ?? 0), y: e.clientY - (host?.top ?? 0) })
  }

  // ── Batch (formatting + structural) ────────────────────────────────────────
  const sendBatch = useCallback(async (requests: unknown[], reload = false) => {
    if (!spreadsheetId) return
    try {
      const res = await fetch('/api/google/sheets/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId, requests }),
      })
      if (!res.ok) throw new Error()
      if (reload && activeTitle) loadValues(spreadsheetId, activeTitle)
    } catch {
      setError('Action failed')
    }
  }, [spreadsheetId, activeTitle, loadValues])

  function gridRange() {
    const { r0, r1, c0, c1 } = norm(sel)
    return {
      sheetId: activeSheet?.sheetId ?? 0,
      startRowIndex: r0, endRowIndex: r1 + 1,
      startColumnIndex: c0, endColumnIndex: c1 + 1,
    }
  }

  function applyFmtOptimistic(patch: CellFmt) {
    const { r0, r1, c0, c1 } = norm(sel)
    setFormats(prev => {
      const next = new Map(prev)
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        next.set(`${r}:${c}`, { ...(next.get(`${r}:${c}`) ?? {}), ...patch })
      }
      return next
    })
  }

  function toggleTextFmt(kind: 'bold' | 'italic' | 'underline') {
    const nextVal = !fmtAt(sel.fr, sel.fc)[kind]
    const patch: CellFmt = kind === 'bold' ? { bold: nextVal } : kind === 'italic' ? { italic: nextVal } : { underline: nextVal }
    applyFmtOptimistic(patch)
    sendBatch([{ repeatCell: { range: gridRange(), cell: { userEnteredFormat: { textFormat: { [kind]: nextVal } } }, fields: `userEnteredFormat.textFormat.${kind}` } }])
  }

  function applyColor(hex: string, which: 'text' | 'bg') {
    const rgb = hexToRgb(hex)
    if (which === 'text') {
      applyFmtOptimistic({ color: hex })
      sendBatch([{ repeatCell: { range: gridRange(), cell: { userEnteredFormat: { textFormat: { foregroundColor: rgb } } }, fields: 'userEnteredFormat.textFormat.foregroundColor' } }])
    } else {
      applyFmtOptimistic({ bg: hex })
      sendBatch([{ repeatCell: { range: gridRange(), cell: { userEnteredFormat: { backgroundColor: rgb } }, fields: 'userEnteredFormat.backgroundColor' } }])
    }
  }

  function applyAlign(align: 'LEFT' | 'CENTER' | 'RIGHT') {
    applyFmtOptimistic({ align })
    sendBatch([{ repeatCell: { range: gridRange(), cell: { userEnteredFormat: { horizontalAlignment: align } }, fields: 'userEnteredFormat.horizontalAlignment' } }])
  }

  function applyNumberFormat(kind: string) {
    const map: Record<string, { type: string; pattern: string } | null> = {
      plain: { type: 'NUMBER', pattern: '0.######' },
      currency: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      percent: { type: 'PERCENT', pattern: '0.00%' },
      date: { type: 'DATE', pattern: 'yyyy-mm-dd' },
    }
    const nf = map[kind]
    if (!nf) return
    sendBatch([{ repeatCell: { range: gridRange(), cell: { userEnteredFormat: { numberFormat: nf } }, fields: 'userEnteredFormat.numberFormat' } }], true)
  }

  // ── Structural (context menu) ──────────────────────────────────────────────
  function dimReq(dimension: 'ROWS' | 'COLUMNS', startIndex: number, endIndex: number, insert: boolean) {
    const range = { sheetId: activeSheet?.sheetId ?? 0, dimension, startIndex, endIndex }
    return insert ? { insertDimension: { range, inheritFromBefore: startIndex > 0 } } : { deleteDimension: { range } }
  }
  function ctxAction(kind: string) {
    const { r0, r1, c0, c1 } = norm(sel)
    setMenu(null)
    if (kind === 'rowAbove') sendBatch([dimReq('ROWS', r0, r0 + 1, true)], true)
    else if (kind === 'rowBelow') sendBatch([dimReq('ROWS', r1 + 1, r1 + 2, true)], true)
    else if (kind === 'colLeft') sendBatch([dimReq('COLUMNS', c0, c0 + 1, true)], true)
    else if (kind === 'colRight') sendBatch([dimReq('COLUMNS', c1 + 1, c1 + 2, true)], true)
    else if (kind === 'delRow') sendBatch([dimReq('ROWS', r0, r1 + 1, false)], true)
    else if (kind === 'delCol') sendBatch([dimReq('COLUMNS', c0, c1 + 1, false)], true)
    else if (kind === 'clear') clearSelection()
  }

  function switchSheet(title: string) {
    if (!spreadsheetId || title === activeTitle) return
    setActiveTitle(title)
    onPersistConfig({ spreadsheetId, activeSheet: title })
    loadValues(spreadsheetId, title)
  }

  async function addSheet() {
    if (!spreadsheetId) return
    const name = `Sheet${(meta?.sheets.length ?? 0) + 1}`
    await sendBatch([{ addSheet: { properties: { title: name } } }])
    const r = await fetch(`/api/google/sheets/metadata?spreadsheetId=${encodeURIComponent(spreadsheetId)}`, { cache: 'no-store' })
    if (r.ok) { const m = (await r.json()) as SpreadsheetMeta; setMeta(m); switchSheet(name) }
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (connected === null) {
    return <Shell><div className="flex items-center justify-center flex-1"><Loader2 size={16} className="animate-spin text-white/30" /></div></Shell>
  }
  if (!connected) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 text-center">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-green-500 to-emerald-600 text-white text-sm font-bold">G</span>
          <p className="text-white/60 text-xs">Connect your Google account to use Sheets.</p>
          <a href="/settings/connected-apps" className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors">Connect Google Account</a>
        </div>
      </Shell>
    )
  }
  if (!spreadsheetId) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center flex-1 gap-2 px-6">
          <p className="text-white/60 text-xs mb-1">Open a Google Sheet</p>
          <input
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmUrl() }}
            placeholder="Paste Google Sheets URL"
            className="w-full max-w-[280px] bg-white/5 rounded px-2 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-white/30"
          />
          <button onClick={confirmUrl} className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium">Open</button>
          {error && <p className="text-red-400/80 text-[11px]">{error}</p>}
        </div>
      </Shell>
    )
  }

  function confirmUrl() {
    const id = parseSpreadsheetId(urlInput)
    if (!id) { setError('That doesn\'t look like a Google Sheets URL.'); return }
    setError(null)
    onPersistConfig({ spreadsheetId: id })
  }

  // ── Virtualization window ──────────────────────────────────────────────────
  const frozenRows = Math.min(activeSheet?.frozenRowCount ?? 0, 3)
  const frozenCols = Math.min(activeSheet?.frozenColumnCount ?? 0, 3)
  const visStart = Math.max(frozenRows, Math.floor(scrollTop / ROW_H) - BUFFER)
  const visEnd = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_H) + BUFFER)
  const topSpacer = Math.max(0, (visStart - frozenRows) * ROW_H)
  const bottomSpacer = Math.max(0, (totalRows - visEnd) * ROW_H)
  const bodyRows: number[] = []
  for (let r = visStart; r < visEnd; r++) bodyRows.push(r)
  const frozenRowList = Array.from({ length: frozenRows }, (_, i) => i)

  const colStyle = (c: number): React.CSSProperties => {
    const w = colWidths[c] ?? DEFAULT_COL_W
    const style: React.CSSProperties = { width: w, minWidth: w }
    if (c < frozenCols) { style.position = 'sticky'; style.left = colOffsets[c]; style.zIndex = 6 }
    return style
  }

  function renderCell(r: number, c: number) {
    const f = fmtAt(r, c)
    const inSel = (() => { const n = norm(sel); return r >= n.r0 && r <= n.r1 && c >= n.c0 && c <= n.c1 })()
    const isFocus = sel.fr === r && sel.fc === c
    const isEditing = editing?.r === r && editing?.c === c
    const frozen = c < frozenCols
    return (
      <div
        key={c}
        onMouseDown={e => onCellMouseDown(e, r, c)}
        onMouseEnter={() => onCellMouseEnter(r, c)}
        onDoubleClick={() => beginEdit(r, c)}
        onContextMenu={e => onCellContextMenu(e, r, c)}
        className={`shrink-0 h-full px-1 text-[11px] leading-[22px] truncate border-r border-b border-white/10 ${inSel ? 'bg-blue-500/20' : frozen ? 'bg-[#161922]' : ''} ${isFocus ? 'outline outline-1 outline-blue-400 -outline-offset-1 z-[1]' : ''}`}
        style={{
          ...colStyle(c),
          color: f.color, backgroundColor: inSel ? undefined : f.bg,
          fontWeight: f.bold ? 700 : undefined,
          fontStyle: f.italic ? 'italic' : undefined,
          textDecoration: f.underline ? 'underline' : undefined,
          textAlign: f.align === 'CENTER' ? 'center' : f.align === 'RIGHT' ? 'right' : 'left',
        }}
      >
        {isEditing ? (
          <input
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={() => commitEdit(null)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit('down') }
              else if (e.key === 'Tab') { e.preventDefault(); commitEdit('right') }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
              e.stopPropagation()
            }}
            className="w-full h-[20px] bg-[#0f1117] text-white text-[11px] px-0.5 outline outline-1 outline-blue-400"
          />
        ) : (
          cellValue(r, c)
        )}
      </div>
    )
  }

  function renderRow(r: number, frozen: boolean): React.ReactNode {
    return (
      <div
        key={r}
        className="flex"
        style={frozen ? { position: 'sticky', top: HEADER_H + r * ROW_H, zIndex: 5, height: ROW_H } : { height: ROW_H }}
      >
        <div
          className="shrink-0 h-full flex items-center justify-center text-[10px] text-white/40 border-r border-b border-white/10 bg-[#161922] sticky left-0"
          style={{ width: ROWNUM_W, zIndex: 7 }}
        >
          {r + 1}
        </div>
        {Array.from({ length: colCount }, (_, c) => renderCell(r, c))}
      </div>
    )
  }

  const focusVal = editing ? editValue : cellValue(sel.fr, sel.fc)

  return (
    <Shell>
      {/* Formatting toolbar */}
      <div className="flex items-center gap-0.5 px-1 py-1 border-b border-white/10 shrink-0 overflow-x-auto">
        <ToolBtn onClick={() => toggleTextFmt('bold')} active={!!fmtAt(sel.fr, sel.fc).bold}><Bold size={12} /></ToolBtn>
        <ToolBtn onClick={() => toggleTextFmt('italic')} active={!!fmtAt(sel.fr, sel.fc).italic}><Italic size={12} /></ToolBtn>
        <ToolBtn onClick={() => toggleTextFmt('underline')} active={!!fmtAt(sel.fr, sel.fc).underline}><Underline size={12} /></ToolBtn>
        <Divider />
        <ColorBtn label="A" title="Text color" onPick={hex => applyColor(hex, 'text')} />
        <ColorBtn label="▦" title="Fill color" onPick={hex => applyColor(hex, 'bg')} />
        <Divider />
        <ToolBtn onClick={() => applyAlign('LEFT')}><AlignLeft size={12} /></ToolBtn>
        <ToolBtn onClick={() => applyAlign('CENTER')}><AlignCenter size={12} /></ToolBtn>
        <ToolBtn onClick={() => applyAlign('RIGHT')}><AlignRight size={12} /></ToolBtn>
        <Divider />
        <select
          onChange={e => { applyNumberFormat(e.target.value); e.currentTarget.selectedIndex = 0 }}
          className="bg-white/5 text-white/70 text-[10px] rounded px-1 py-0.5 focus:outline-none"
          defaultValue=""
          title="Number format"
        >
          <option value="" className="bg-[#1b1e26]">123</option>
          <option value="plain" className="bg-[#1b1e26]">Plain</option>
          <option value="currency" className="bg-[#1b1e26]">Currency</option>
          <option value="percent" className="bg-[#1b1e26]">Percent</option>
          <option value="date" className="bg-[#1b1e26]">Date</option>
        </select>
        {loading && <Loader2 size={12} className="animate-spin text-white/30 ml-auto shrink-0" />}
      </div>

      {/* Formula bar */}
      <div className="flex items-center gap-1 px-1 py-0.5 border-b border-white/10 shrink-0">
        <span className="text-[10px] text-white/40 font-mono w-12 shrink-0 text-center">{a1(sel.fr, sel.fc)}</span>
        <span className="text-white/20 text-xs shrink-0">fx</span>
        <input
          value={focusVal}
          onChange={e => { if (editing) setEditValue(e.target.value); else beginEdit(sel.fr, sel.fc, e.target.value) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitEdit('down') } else if (e.key === 'Escape') setEditing(null) }}
          placeholder="Enter value or =formula"
          className="flex-1 min-w-0 bg-transparent text-[11px] text-white placeholder-white/25 focus:outline-none"
        />
      </div>

      {error && <div className="px-2 py-0.5 text-[10px] text-red-400/80 bg-red-500/10 shrink-0">{error}</div>}

      {/* Grid */}
      <div
        ref={scrollRef}
        tabIndex={0}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onGridKeyDown}
        className="flex-1 overflow-auto outline-none relative"
      >
        <div style={{ width: totalWidth, position: 'relative' }}>
          {/* Column header */}
          <div className="flex sticky top-0 z-20" style={{ height: HEADER_H }}>
            <div className="shrink-0 bg-[#1b1e26] border-r border-b border-white/10 sticky left-0" style={{ width: ROWNUM_W, zIndex: 8 }} />
            {Array.from({ length: colCount }, (_, c) => (
              <div
                key={c}
                className="shrink-0 h-full flex items-center justify-center text-[10px] text-white/45 bg-[#1b1e26] border-r border-b border-white/10 relative select-none"
                style={colStyle(c)}
              >
                {colName(c)}
                <div
                  onMouseDown={e => { e.preventDefault(); resizeRef.current = { col: c, startX: e.clientX, startW: colWidths[c] ?? DEFAULT_COL_W } }}
                  className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-400/60"
                />
              </div>
            ))}
          </div>

          {/* Frozen rows */}
          {frozenRowList.map(r => renderRow(r, true))}
          {/* Virtualized body */}
          <div style={{ height: topSpacer }} />
          {bodyRows.map(r => renderRow(r, false))}
          <div style={{ height: bottomSpacer }} />
        </div>
      </div>

      {/* Sheet tab bar */}
      <div className="flex items-center gap-0.5 px-1 py-0.5 border-t border-white/10 shrink-0 overflow-x-auto bg-[#161922]">
        {meta?.sheets.map(s => (
          <button
            key={s.sheetId}
            onClick={() => switchSheet(s.title)}
            className={`px-2 py-0.5 rounded text-[10px] whitespace-nowrap transition-colors ${s.title === activeTitle ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`}
          >
            {s.title}
          </button>
        ))}
        <button onClick={addSheet} className="px-1 py-0.5 rounded text-white/40 hover:text-white/70 shrink-0" title="Add sheet"><Plus size={11} /></button>
      </div>

      {/* Context menu */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null) }} />
          <div className="absolute z-50 bg-[#1b1e26] border border-white/10 rounded-lg shadow-2xl py-1 text-[11px] text-white/80 w-44" style={{ left: menu.x, top: menu.y }}>
            {[
              ['rowAbove', 'Insert row above'], ['rowBelow', 'Insert row below'],
              ['colLeft', 'Insert column left'], ['colRight', 'Insert column right'],
              ['delRow', 'Delete row(s)'], ['delCol', 'Delete column(s)'],
              ['clear', 'Clear contents'],
            ].map(([k, label], i) => (
              <button key={k} onClick={() => ctxAction(k)} className={`w-full text-left px-3 py-1 hover:bg-white/10 ${i === 4 || i === 6 ? 'border-t border-white/10' : ''}`}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </Shell>
  )
}

// ── small UI helpers ──────────────────────────────────────────────────────────
function ToolBtn({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`p-1 rounded shrink-0 ${active ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-4 bg-white/10 mx-0.5 shrink-0" />
}

function ColorBtn({ label, title, onPick }: { label: string; title: string; onPick: (hex: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <button onClick={() => ref.current?.click()} title={title} className="p-1 rounded text-white/60 hover:bg-white/10 hover:text-white shrink-0 relative text-[11px] leading-none">
      {label}
      <input ref={ref} type="color" className="sr-only" onChange={e => onPick(e.target.value)} />
    </button>
  )
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map(x => x + x).join('') : m, 16)
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 }
}
