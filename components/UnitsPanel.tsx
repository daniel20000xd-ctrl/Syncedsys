'use client'

import { useState, useRef, useEffect } from 'react'
import { GripVertical, Settings2, List as ListIcon, Square, Type, Image as ImageIcon, Pencil, CreditCard, Frame, Eye, EyeOff, FileText, LayoutDashboard, AlignLeft, X, Trash2, ChevronRight, Link2, Database } from 'lucide-react'
import { useUnits, usePanelSel, unitsStore, type Unit } from '@/lib/unitsStore'

function UnitIcon({ u }: { u: Unit }) {
  if (u.kind === 'subtab') {
    if (u.mode === 'text')        return <AlignLeft size={13} className="shrink-0 text-white/50" />
    if (u.mode === 'folder')      return <FileText size={13} className="shrink-0 text-white/50" />
    if (u.mode === 'trello')      return <LayoutDashboard size={13} className="shrink-0 text-white/50" />
    if (u.mode === 'database')    return <Database size={13} className="shrink-0 text-white/50" />
    return <Square size={13} className="shrink-0 text-white/50" />
  }
  const icons: Partial<Record<Unit['kind'], typeof Square>> = {
    list: ListIcon, card: CreditCard, shape: Square, text: Type,
    image: ImageIcon, drawing: Pencil, portal: Frame, file: FileText, link: Link2,
  }
  const Icon = icons[u.kind] ?? Square
  return <Icon size={13} className="shrink-0 text-white/50" />
}

function RenameField({ id, label, onDone }: { id: string; label: string; onDone: () => void }) {
  const [draft, setDraft] = useState(label)
  const ref = useRef<HTMLInputElement>(null)

  function commit() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== label) unitsStore.rename(id, trimmed)
    onDone()
  }

  return (
    <input
      ref={ref}
      autoFocus
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onDone()
        e.stopPropagation()
      }}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      className="nodrag flex-1 min-w-0 bg-white/15 text-white text-[12px] rounded px-1 py-0 focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  )
}

// A row for an individual unit (used both in the main list and inside the drawing group)
function UnitRow({
  u, idx, dragId, overId, settingsId, renamingId, panelSel,
  indented, hideDrag,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onClick, onDoubleClick,
  onSettingsToggle, onRenameCommit,
}: {
  u: Unit; idx: number
  dragId: string | null; overId: string | null; settingsId: string | null; renamingId: string | null
  panelSel: Set<string>
  indented?: boolean; hideDrag?: boolean
  onDragStart: () => void; onDragOver: () => void; onDrop: () => void; onDragEnd: () => void
  onClick: (e: React.MouseEvent) => void; onDoubleClick: () => void
  onSettingsToggle: () => void; onRenameCommit: () => void
}) {
  const isOpen = settingsId === u.id
  const isRenaming = renamingId === u.id
  const inSel = panelSel.has(u.id)

  return (
    <div key={u.id} className={indented ? 'pl-5' : ''}>
      <div
        onDragOver={e => { e.preventDefault(); onDragOver() }}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        className={`group flex items-center gap-1.5 px-1.5 py-1 rounded text-sm transition-colors select-none
          ${inSel
            ? 'bg-blue-400/20 ring-1 ring-inset ring-blue-400/40 text-white cursor-pointer'
            : u.hidden
              ? 'opacity-40 cursor-default'
              : u.selected
                ? 'bg-blue-500/30 text-white cursor-pointer'
                : 'text-white/70 hover:bg-white/10 hover:text-white cursor-pointer'
          }
          ${overId === u.id && dragId ? 'border-t-2 border-blue-400' : 'border-t-2 border-transparent'}`}
      >
        {!hideDrag && (
          <div
            draggable={!u.hidden && !isRenaming}
            onDragStart={e => { e.stopPropagation(); onDragStart() }}
            onMouseDown={e => e.stopPropagation()}
            className="shrink-0 text-white/25 group-hover:text-white/50 cursor-grab"
          >
            <GripVertical size={12} />
          </div>
        )}
        {hideDrag && <div className="shrink-0 w-3" />}

        <UnitIcon u={u} />

        {isRenaming ? (
          <RenameField id={u.id} label={u.label} onDone={onRenameCommit} />
        ) : (
          <span className={`truncate flex-1 text-left text-[13px] ${u.hidden ? 'line-through text-white/30' : ''}`}>
            {u.label || u.kind}
          </span>
        )}

        {!u.hidden && u.opacity < 1 && <span className="text-[9px] text-white/30">{Math.round(u.opacity * 100)}%</span>}

        <button
          onClick={e => { e.stopPropagation(); unitsStore.setHidden(u.id, !u.hidden) }}
          onMouseDown={e => e.stopPropagation()}
          className={`p-0.5 rounded shrink-0 transition-colors ${
            u.hidden
              ? 'text-white/60 hover:text-white opacity-100'
              : 'text-white/30 hover:text-white opacity-0 group-hover:opacity-100'
          }`}
          title={u.hidden ? 'Show unit' : 'Hide unit'}
        >
          {u.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>

        {!u.hidden && (
          <button
            onClick={e => { e.stopPropagation(); onSettingsToggle() }}
            onMouseDown={e => e.stopPropagation()}
            className={`p-0.5 rounded shrink-0 ${isOpen ? 'text-white bg-white/15' : 'text-white/30 hover:text-white opacity-0 group-hover:opacity-100'}`}
            title="Unit settings"
          >
            <Settings2 size={12} />
          </button>
        )}
      </div>

      {isOpen && !u.hidden && (
        <div className="mx-2 mb-1 mt-0.5 p-2 rounded bg-black/30 border border-white/10">
          <label className="flex items-center justify-between text-[10px] text-white/50 mb-1">
            <span>Opacity</span>
            <span>{Math.round(u.opacity * 100)}%</span>
          </label>
          <input
            type="range" min={10} max={100}
            value={Math.round(u.opacity * 100)}
            onChange={e => unitsStore.setOpacity(u.id, Number(e.target.value) / 100)}
            className="w-full accent-blue-500"
          />
          <button
            onClick={() => { unitsStore.setHidden(u.id, true); }}
            onMouseDown={e => e.stopPropagation()}
            className="mt-2 w-full flex items-center justify-center gap-1.5 text-[10px] text-white/40 hover:text-white/70 py-1 rounded hover:bg-white/10"
          >
            <EyeOff size={10} /> Hide unit
          </button>
        </div>
      )}
    </div>
  )
}

export default function UnitsPanel() {
  const units = useUnits()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [settingsId, setSettingsId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [drawingsOpen, setDrawingsOpen] = useState(false)

  const panelSel = usePanelSel()
  const [lastSelIdx, setLastSelIdx] = useState<number | null>(null)
  const [selCtxMenu, setSelCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const isLassoDown = useRef(false)
  const didLassoDrag = useRef(false)
  const lassoStartId = useRef<string | null>(null)

  useEffect(() => {
    const onUp = () => { isLassoDown.current = false }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    if (!selCtxMenu) return
    const close = () => setSelCtxMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [selCtxMenu])

  if (units.length === 0) {
    return <p className="px-3 py-1 text-xs text-white/30">No units yet</p>
  }

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return }
    const ids = units.map(u => u.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    unitsStore.reorder(ids)
    setDragId(null)
    setOverId(null)
  }

  // Build the visible list: drawings are collapsed into one group entry
  const drawings = units.filter(u => u.kind === 'drawing')
  const allDrawingsHidden = drawings.length > 0 && drawings.every(u => u.hidden)

  type Item = { type: 'unit'; u: Unit; origIdx: number } | { type: 'drawingGroup' }
  const items: Item[] = []
  let groupInserted = false
  units.forEach((u, origIdx) => {
    if (u.kind === 'drawing') {
      if (!groupInserted) { items.push({ type: 'drawingGroup' }); groupInserted = true }
      if (drawingsOpen) items.push({ type: 'unit', u, origIdx })
    } else {
      items.push({ type: 'unit', u, origIdx })
    }
  })

  function handleRowClick(e: React.MouseEvent, id: string, visIdx: number, isHidden: boolean) {
    if (didLassoDrag.current) { didLassoDrag.current = false; return }
    if (renamingId === id) return

    if (e.shiftKey && lastSelIdx !== null) {
      const lo = Math.min(lastSelIdx, visIdx)
      const hi = Math.max(lastSelIdx, visIdx)
      const next = new Set(unitsStore.getPanelSel())
      // Select all real units in that range
      items.slice(lo, hi + 1).forEach(item => {
        if (item.type === 'unit') next.add(item.u.id)
      })
      unitsStore.setPanelSel(next)
    } else {
      const wasSelected = panelSel.has(id)
      const next = new Set(unitsStore.getPanelSel())
      if (next.has(id)) next.delete(id)
      else next.add(id)
      unitsStore.setPanelSel(next)
      setLastSelIdx(visIdx)
      if (!wasSelected && !isHidden) unitsStore.select(id)
    }
  }

  function applyVisibility(hidden: boolean) {
    panelSel.forEach(id => unitsStore.setHidden(id, hidden))
    unitsStore.setPanelSel(new Set())
  }

  return (
    <div
      className="px-1"
      onMouseLeave={() => { if (panelSel.size > 0) unitsStore.setPanelSel(new Set()) }}
      onContextMenu={e => {
        if (panelSel.size === 0) return
        e.preventDefault()
        setSelCtxMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <p className="px-2 py-1 text-[9px] text-white/30">Top = front layer · drag grip to reorder · click or drag to select</p>

      {panelSel.size > 0 && (
        <div className="flex items-center gap-1 mx-1 mb-1 px-2 py-1 rounded bg-white/5 border border-white/10">
          <span className="text-[10px] text-white/40 flex-1">{panelSel.size} selected</span>
          <button
            onClick={() => applyVisibility(true)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            <EyeOff size={10} /> Hide
          </button>
          <button
            onClick={() => applyVisibility(false)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Eye size={10} /> Show
          </button>
          <button
            onClick={() => unitsStore.setPanelSel(new Set())}
            onMouseDown={e => e.stopPropagation()}
            className="p-0.5 rounded text-white/30 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {items.map((item, visIdx) => {
        if (item.type === 'drawingGroup') {
          return (
            <div key="__drawing_group">
              <div
                onClick={() => setDrawingsOpen(o => !o)}
                className="group flex items-center gap-1.5 px-1.5 py-1 rounded text-sm transition-colors select-none text-white/70 hover:bg-white/10 hover:text-white cursor-pointer border-t-2 border-transparent"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 text-white/25 group-hover:text-white/50 transition-transform ${drawingsOpen ? 'rotate-90' : ''}`}
                />
                <Pencil size={13} className="shrink-0 text-white/50" />
                <span className="truncate flex-1 text-left text-[13px]">
                  Drawings <span className="text-white/30 text-[11px]">({drawings.length})</span>
                </span>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    drawings.forEach(d => unitsStore.setHidden(d.id, !allDrawingsHidden))
                  }}
                  onMouseDown={e => e.stopPropagation()}
                  className="p-0.5 rounded shrink-0 transition-colors text-white/30 hover:text-white opacity-0 group-hover:opacity-100"
                  title={allDrawingsHidden ? 'Show all drawings' : 'Hide all drawings'}
                >
                  {allDrawingsHidden ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
            </div>
          )
        }

        const { u, origIdx } = item
        return (
          <UnitRow
            key={u.id}
            u={u} idx={origIdx}
            dragId={dragId} overId={overId} settingsId={settingsId} renamingId={renamingId}
            panelSel={panelSel}
            indented={drawingsOpen && u.kind === 'drawing'}
            hideDrag={u.kind === 'drawing'}
            onDragStart={() => setDragId(u.id)}
            onDragOver={() => setOverId(u.id)}
            onDrop={() => handleDrop(u.id)}
            onDragEnd={() => { setDragId(null); setOverId(null) }}
            onClick={e => {
              if (e.button !== 0) return
              handleRowClick(e, u.id, visIdx, u.hidden)
            }}
            onDoubleClick={() => { if (!u.hidden) { setSettingsId(null); setRenamingId(u.id) } }}
            onSettingsToggle={() => { setRenamingId(null); setSettingsId(settingsId === u.id ? null : u.id) }}
            onRenameCommit={() => setRenamingId(null)}
          />
        )
      })}

      {selCtxMenu && (
        <div
          className="fixed bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 z-[300] w-48"
          style={{ top: selCtxMenu.y, left: selCtxMenu.x }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="px-4 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-100 mb-1">
            {panelSel.size} selected
          </div>
          <button
            onClick={() => { applyVisibility(true); setSelCtxMenu(null) }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors flex items-center gap-2"
          >
            <EyeOff size={13} /> Hide
          </button>
          <button
            onClick={() => { applyVisibility(false); setSelCtxMenu(null) }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors flex items-center gap-2"
          >
            <Eye size={13} /> Show
          </button>
          <div className="border-t border-gray-100 my-1" />
          <button
            onClick={() => { unitsStore.delete([...panelSel]); unitsStore.setPanelSel(new Set()); setSelCtxMenu(null) }}
            className="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}
    </div>
  )
}
