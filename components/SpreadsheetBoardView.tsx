'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import type { Board } from '@/lib/types'
import { updateBoardContent } from '@/app/actions'
import {
  parseSheet, serializeSheet, computeSheet, cellAddr, colToLetter, numericValue,
  type SheetData,
} from '@/lib/spreadsheet'

const COL_W = 100
const ROW_H = 26
const HEAD_W = 46

export default function SpreadsheetBoardView({ board }: { board: Board }) {
  const [data, setData] = useState<SheetData>(() => parseSheet(board.content))
  const [active, setActive] = useState({ r: 0, c: 0 })
  const [anchor, setAnchor] = useState({ r: 0, c: 0 })
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [editSource, setEditSource] = useState<'cell' | 'bar'>('cell')
  const gridRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const computed = useMemo(() => computeSheet(data), [data])

  const raw = (r: number, c: number) => data.cells[cellAddr(r, c)] ?? ''
  const disp = (r: number, c: number) => computed[cellAddr(r, c)]?.display ?? ''

  const save = useCallback((next: SheetData) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { updateBoardContent(board.id, serializeSheet(next)).catch(err => console.error('save failed', err)) }, 500)
  }, [board.id])

  function writeCells(updates: { r: number; c: number; v: string }[], grow = true) {
    setData(prev => {
      const cells = { ...prev.cells }
      let rows = prev.rows, cols = prev.cols
      for (const u of updates) {
        const a = cellAddr(u.r, u.c)
        if (u.v === '') delete cells[a]; else cells[a] = u.v
        if (grow) { rows = Math.max(rows, u.r + 1); cols = Math.max(cols, u.c + 1) }
      }
      const next = { rows, cols, cells }
      save(next)
      return next
    })
  }

  function focusGrid() { requestAnimationFrame(() => gridRef.current?.focus()) }

  function startEdit(initial?: string, source: 'cell' | 'bar' = 'cell') {
    setEditValue(initial ?? raw(active.r, active.c))
    setEditSource(source)
    setEditing(true)
    if (source === 'cell') requestAnimationFrame(() => { inputRef.current?.focus(); if (initial === undefined) inputRef.current?.select() })
  }

  function commitEdit(move?: { dr: number; dc: number }) {
    writeCells([{ r: active.r, c: active.c, v: editValue }])
    setEditing(false)
    if (move) moveActive(move.dr, move.dc)
    focusGrid()
  }

  function cancelEdit() { setEditing(false); focusGrid() }

  function moveActive(dr: number, dc: number, extend = false) {
    setActive(prev => {
      const r = Math.min(Math.max(0, prev.r + dr), data.rows - 1)
      const c = Math.min(Math.max(0, prev.c + dc), data.cols - 1)
      if (!extend) setAnchor({ r, c })
      return { r, c }
    })
  }

  function selectCell(r: number, c: number, extend = false) {
    setActive({ r, c })
    if (!extend) setAnchor({ r, c })
  }

  // Selection rectangle
  const rect = {
    r0: Math.min(active.r, anchor.r), r1: Math.max(active.r, anchor.r),
    c0: Math.min(active.c, anchor.c), c1: Math.max(active.c, anchor.c),
  }
  const inRect = (r: number, c: number) => r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1

  // Status bar aggregate over the selection
  const stats = useMemo(() => {
    const nums: number[] = []
    let cellCount = 0
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) {
      cellCount++
      const n = numericValue(computed[cellAddr(r, c)])
      if (n !== null) nums.push(n)
    }
    const sum = nums.reduce((a, b) => a + b, 0)
    return { cellCount, count: nums.length, sum, avg: nums.length ? sum / nums.length : 0 }
  }, [rect.r0, rect.r1, rect.c0, rect.c1, computed])

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing) return
    const k = e.key
    if (k === 'ArrowUp') { e.preventDefault(); moveActive(-1, 0, e.shiftKey) }
    else if (k === 'ArrowDown') { e.preventDefault(); moveActive(1, 0, e.shiftKey) }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveActive(0, -1, e.shiftKey) }
    else if (k === 'ArrowRight') { e.preventDefault(); moveActive(0, 1, e.shiftKey) }
    else if (k === 'Tab') { e.preventDefault(); moveActive(0, e.shiftKey ? -1 : 1) }
    else if (k === 'Enter') { e.preventDefault(); startEdit() }
    else if (k === 'F2') { e.preventDefault(); startEdit() }
    else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault()
      const ups: { r: number; c: number; v: string }[] = []
      for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) ups.push({ r, c, v: '' })
      writeCells(ups, false)
    }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) { startEdit(k) }
  }

  function onCopy(e: React.ClipboardEvent) {
    if (editing) return
    const lines: string[] = []
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row: string[] = []
      for (let c = rect.c0; c <= rect.c1; c++) row.push(disp(r, c))
      lines.push(row.join('\t'))
    }
    e.clipboardData.setData('text/plain', lines.join('\n'))
    e.preventDefault()
  }

  function onPaste(e: React.ClipboardEvent) {
    if (editing) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'))
    const ups: { r: number; c: number; v: string }[] = []
    rows.forEach((cols, dr) => cols.forEach((v, dc) => ups.push({ r: active.r + dr, c: active.c + dc, v })))
    writeCells(ups)
  }

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const activeAddr = cellAddr(active.r, active.c)

  return (
    <div className="flex-1 h-full flex flex-col bg-white">
      {/* Formula bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 bg-gray-50">
        <span className="text-xs font-mono font-semibold text-gray-500 w-12 text-center bg-white border border-gray-200 rounded py-0.5">{activeAddr}</span>
        <span className="text-gray-300">fx</span>
        <input
          value={editing ? editValue : raw(active.r, active.c)}
          onChange={e => { if (!editing) startEdit(e.target.value, 'bar'); else setEditValue(e.target.value) }}
          onFocus={() => { if (!editing) startEdit(undefined, 'bar'); else setEditSource('bar') }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit({ dr: 1, dc: 0 }) }
            if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
          }}
          placeholder="Value or =formula"
          className="flex-1 text-sm font-mono text-gray-800 bg-white border border-gray-200 rounded px-2 py-0.5 focus:outline-none focus:border-blue-400"
        />
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
        className="flex-1 overflow-auto outline-none select-none"
      >
        <div style={{ width: HEAD_W + data.cols * COL_W }}>
          {/* Column headers */}
          <div className="flex sticky top-0 z-20">
            <div className="sticky left-0 z-30 bg-gray-100 border-b border-r border-gray-300 shrink-0" style={{ width: HEAD_W, height: ROW_H }} />
            {Array.from({ length: data.cols }, (_, c) => (
              <div key={c} className={`shrink-0 flex items-center justify-center text-[11px] font-semibold border-b border-r border-gray-300 ${c >= rect.c0 && c <= rect.c1 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`} style={{ width: COL_W, height: ROW_H }}>
                {colToLetter(c)}
              </div>
            ))}
          </div>

          {/* Rows */}
          {Array.from({ length: data.rows }, (_, r) => (
            <div key={r} className="flex">
              <div className={`sticky left-0 z-10 shrink-0 flex items-center justify-center text-[11px] font-semibold border-b border-r border-gray-300 ${r >= rect.r0 && r <= rect.r1 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`} style={{ width: HEAD_W, height: ROW_H }}>
                {r + 1}
              </div>
              {Array.from({ length: data.cols }, (_, c) => {
                const isActive = active.r === r && active.c === c
                const selected = inRect(r, c)
                const cell = computed[cellAddr(r, c)]
                const isNum = numericValue(cell) !== null && (data.cells[cellAddr(r, c)] ?? '')[0] !== "'"
                return (
                  <div
                    key={c}
                    onMouseDown={e => { if (!isActive || !editing) selectCell(r, c, e.shiftKey) }}
                    onDoubleClick={() => { setActive({ r, c }); setAnchor({ r, c }); startEdit() }}
                    className={`shrink-0 relative border-b border-r border-gray-200 text-[13px] ${selected && !isActive ? 'bg-blue-50' : ''} ${isActive ? 'ring-2 ring-blue-500 ring-inset z-10 bg-white' : ''}`}
                    style={{ width: COL_W, height: ROW_H }}
                  >
                    {isActive && editing && editSource === 'cell' ? (
                      <input
                        ref={inputRef}
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onBlur={() => commitEdit()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit({ dr: 1, dc: 0 }) }
                          else if (e.key === 'Tab') { e.preventDefault(); commitEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 }) }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                        }}
                        className="absolute inset-0 w-full h-full px-1 text-[13px] font-mono focus:outline-none bg-white"
                      />
                    ) : (
                      <div className={`w-full h-full px-1 leading-[24px] overflow-hidden whitespace-nowrap ${isNum ? 'text-right' : 'text-left'} ${typeof cell?.value === 'object' ? 'text-red-500' : 'text-gray-800'}`}>
                        {isActive && editing && editSource === 'bar' ? editValue : disp(r, c)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {/* Add rows / columns */}
          <div className="flex gap-2 p-2">
            <button onClick={() => setData(prev => { const n = { ...prev, rows: prev.rows + 20 }; save(n); return n })} className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 border border-gray-200 rounded px-2 py-1">
              <Plus size={12} /> 20 rows
            </button>
            <button onClick={() => setData(prev => { const n = { ...prev, cols: prev.cols + 5 }; save(n); return n })} className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 border border-gray-200 rounded px-2 py-1">
              <Plus size={12} /> 5 columns
            </button>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-end gap-4 px-3 py-1 border-t border-gray-200 bg-gray-50 text-[11px] text-gray-500">
        {stats.cellCount > 1 && (
          <>
            <span>Count: {stats.count}</span>
            <span>Sum: {formatStat(stats.sum)}</span>
            {stats.count > 0 && <span>Avg: {formatStat(stats.avg)}</span>}
          </>
        )}
        <span className="text-gray-400">{board.name} · spreadsheet</span>
      </div>
    </div>
  )
}

function formatStat(n: number): string {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}
