'use client'

import { useState, useRef } from 'react'
import { GripVertical, Settings2, List as ListIcon, Square, Type, Image as ImageIcon, Pencil, CreditCard, Frame, Eye, EyeOff, FileText, LayoutDashboard, AlignLeft, TableProperties } from 'lucide-react'
import { useUnits, unitsStore, type Unit } from '@/lib/unitsStore'

// Icon for a unit — subtabs use their board mode to pick a distinct icon
function UnitIcon({ u }: { u: Unit }) {
  if (u.kind === 'subtab') {
    if (u.mode === 'text')        return <AlignLeft size={13} className="shrink-0 text-white/50" />
    if (u.mode === 'folder')      return <FileText size={13} className="shrink-0 text-white/50" />
    if (u.mode === 'spreadsheet') return <TableProperties size={13} className="shrink-0 text-white/50" />
    if (u.mode === 'trello')      return <LayoutDashboard size={13} className="shrink-0 text-white/50" />
    return <Square size={13} className="shrink-0 text-white/50" /> // classic canvas
  }
  const icons: Partial<Record<Unit['kind'], typeof Square>> = {
    list: ListIcon, card: CreditCard, shape: Square, text: Type,
    image: ImageIcon, drawing: Pencil, portal: Frame, file: FileText,
  }
  const Icon = icons[u.kind] ?? Square
  return <Icon size={13} className="shrink-0 text-white/50" />
}

// Inline rename field — shown when the user double-clicks a label
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
      className="nodrag flex-1 min-w-0 bg-white/15 text-white text-[12px] rounded px-1 py-0 focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  )
}

export default function UnitsPanel() {
  const units = useUnits()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [settingsId, setSettingsId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

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

  return (
    <div className="px-1">
      <p className="px-2 py-1 text-[9px] text-white/30">Top = front layer · drag to reorder · double-click to rename</p>
      {units.map(u => {
        const isOpen = settingsId === u.id
        const isRenaming = renamingId === u.id
        return (
          <div key={u.id}>
            <div
              draggable={!u.hidden && !isRenaming}
              onDragStart={() => setDragId(u.id)}
              onDragOver={e => { e.preventDefault(); setOverId(u.id) }}
              onDrop={() => handleDrop(u.id)}
              onDragEnd={() => { setDragId(null); setOverId(null) }}
              onClick={() => { if (!isRenaming && !u.hidden) unitsStore.select(u.id) }}
              onDoubleClick={() => { if (!u.hidden) { setSettingsId(null); setRenamingId(u.id) } }}
              className={`group flex items-center gap-1.5 px-1.5 py-1 rounded text-sm transition-colors
                ${u.hidden
                  ? 'opacity-40 cursor-default'
                  : u.selected
                    ? 'bg-blue-500/30 text-white cursor-pointer'
                    : 'text-white/70 hover:bg-white/10 hover:text-white cursor-pointer'
                }
                ${overId === u.id && dragId ? 'border-t-2 border-blue-400' : 'border-t-2 border-transparent'}`}
            >
              <GripVertical size={12} className="shrink-0 text-white/25 group-hover:text-white/50 cursor-grab" />
              <UnitIcon u={u} />

              {isRenaming ? (
                <RenameField id={u.id} label={u.label} onDone={() => setRenamingId(null)} />
              ) : (
                <span className={`truncate flex-1 text-left text-[13px] ${u.hidden ? 'line-through text-white/30' : ''}`}>
                  {u.label || u.kind}
                </span>
              )}

              {!u.hidden && u.opacity < 1 && <span className="text-[9px] text-white/30">{Math.round(u.opacity * 100)}%</span>}

              <button
                onClick={e => { e.stopPropagation(); unitsStore.setHidden(u.id, !u.hidden) }}
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
                  onClick={e => { e.stopPropagation(); setRenamingId(null); setSettingsId(isOpen ? null : u.id) }}
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
                  onClick={() => { unitsStore.setHidden(u.id, true); setSettingsId(null) }}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 text-[10px] text-white/40 hover:text-white/70 py-1 rounded hover:bg-white/10"
                >
                  <EyeOff size={10} /> Hide unit
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
