'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { Board } from '@/lib/types'
import { updateBoard, createSubTab, setBoardSynced } from '@/app/actions'

const COLORS = [
  '#0079bf', '#d29034', '#519839', '#b04632',
  '#89609e', '#cd5a91', '#4bbf6b', '#00aecc',
  '#344563', '#f2d600',
]

interface Props {
  board: Board
  anchorRect: DOMRect
  onClose: () => void
  onUpdate: (updated: Board) => void
  showAddSubTab?: boolean
  onRemove?: () => void
}

export default function BoardPropertiesPanel({ board, anchorRect, onClose, onUpdate, showAddSubTab = true, onRemove }: Props) {
  const router = useRouter()
  const [name, setName] = useState(board.name)
  const [color, setColor] = useState(board.color)
  const [hasDeadline, setHasDeadline] = useState(!!board.deadline)
  const [deadline, setDeadline] = useState(board.deadline ? board.deadline.slice(0, 10) : '')
  const [mode, setMode] = useState<'classic' | 'trello' | 'text'>(board.mode ?? 'classic')
  const [synced, setSynced] = useState(!!board.synced)
  const [saving, setSaving] = useState(false)
  const [subTabCreating, setSubTabCreating] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const top = anchorRect.bottom + 6
  const left = Math.min(anchorRect.left, window.innerWidth - 272)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [onClose])

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await updateBoard(board.id, {
        name: name.trim() || board.name,
        color,
        deadline: hasDeadline && deadline ? new Date(deadline).toISOString() : null,
        mode,
      })
      if (synced !== !!board.synced) await setBoardSynced(board.id, synced)
      onUpdate({ ...updated, synced })
      onClose()
    } catch (err) {
      console.error('Failed to save board:', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleAddSubTab() {
    if (subTabCreating) return
    setSubTabCreating(true)
    try {
      const sub = await createSubTab(board.id, 'New tab', board.color)
      onClose()
      router.push(`/board/${sub.id}`)
      router.refresh()
    } finally {
      setSubTabCreating(false)
    }
  }

  return createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', top, left, zIndex: 9999 }}
      className="bg-white rounded-lg shadow-xl border border-gray-200 p-4 w-64"
      onClick={e => e.stopPropagation()}
    >
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Board properties</p>

      <label className="block text-xs text-gray-600 mb-1">Name</label>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:border-blue-500"
      />

      <label className="block text-xs text-gray-600 mb-1.5">Color</label>
      <div className="grid grid-cols-5 gap-1.5 mb-3">
        {COLORS.map(c => (
          <button key={c} onClick={() => setColor(c)} className="h-7 rounded transition-transform hover:scale-105 relative" style={{ backgroundColor: c }}>
            {color === c && <Check size={12} className="absolute inset-0 m-auto text-white drop-shadow" />}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none mb-1.5">
          <input type="checkbox" checked={hasDeadline} onChange={e => setHasDeadline(e.target.checked)} className="rounded" />
          Set expiry date (optional)
        </label>
        {hasDeadline && (
          <>
            <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
            <p className="text-[10px] text-gray-400 mt-1">Board will be marked expired after this date.</p>
          </>
        )}
      </div>

      <label className="block text-xs text-gray-600 mb-1.5">Board preset</label>
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {(['classic', 'trello', 'text'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} className={`py-2 rounded text-xs font-medium border capitalize transition-colors ${mode === m ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
            {m === 'classic' ? '🎨 Classic' : m === 'trello' ? '🗂 Trello' : '📝 Text'}
          </button>
        ))}
      </div>
      {mode === 'classic' && <p className="text-[10px] text-gray-400 mb-3">Freeform canvas — drag anything, draw connections.</p>}
      {mode === 'trello' && <p className="text-[10px] text-gray-400 mb-3">Kanban columns and cards.</p>}
      {mode === 'text' && <p className="text-[10px] text-gray-400 mb-3">Document — a plain writing space, auto-saved.</p>}

      <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none mb-1">
        <input type="checkbox" checked={synced} onChange={e => setSynced(e.target.checked)} className="rounded" />
        Sync to connected iOS apps
      </label>
      <p className="text-[10px] text-gray-400 mb-4">Synced tabs are available to your paired iOS devices.</p>

      <button onClick={handleSave} disabled={saving} className="w-full bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm py-1.5 rounded disabled:opacity-60">
        {saving ? 'Saving…' : 'Save'}
      </button>

      {showAddSubTab && (
        <div className="border-t border-gray-200 mt-3 pt-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Sub-tabs</p>
          <button
            onClick={handleAddSubTab}
            disabled={subTabCreating}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 disabled:opacity-50"
          >
            <Plus size={12} />
            {subTabCreating ? 'Creating…' : 'Add sub-tab'}
          </button>
        </div>
      )}

      {onRemove && (
        <div className="border-t border-gray-200 mt-3 pt-3">
          <button
            onClick={() => { onRemove(); onClose() }}
            className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1"
          >
            <Trash2 size={12} /> Remove tab
          </button>
        </div>
      )}
    </div>,
    document.body
  )
}
