'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Check, Plus, Trash2, Lock, AlertTriangle } from 'lucide-react'
import type { Board } from '@/lib/types'
import { updateBoard, createSubTab, layoutBoardGrid } from '@/app/actions'

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
  const [mode, setMode] = useState<'classic' | 'trello' | 'text' | 'folder'>(board.mode ?? 'classic')
  const [saving, setSaving] = useState(false)
  // Text tabs are locked to text after creation.
  const textLocked = (board.mode ?? 'classic') === 'text'
  // Warnings shown inline before a potentially surprising mode switch.
  const warnings: string[] = []
  if (mode !== board.mode) {
    if (mode === 'text') {
      warnings.push('Lists, cards and any canvas items stay saved but are hidden in Text mode.')
      warnings.push('Text tabs are locked to text — you won’t be able to switch this tab to another mode afterwards.')
    } else if (mode === 'folder') {
      warnings.push('Folder view shows sub-folders and text files only. Lists, cards, shapes, drawings and connections stay saved but are hidden here.')
    } else if (board.mode === 'classic' && mode === 'trello') {
      warnings.push('Shapes, drawings, connections and sub-tabs stay saved but are hidden until you switch back to Classic.')
    }
  }
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
    const modeChanged = mode !== board.mode
    setSaving(true)
    try {
      const updated = await updateBoard(board.id, {
        name: name.trim() || board.name,
        color,
        deadline: hasDeadline && deadline ? new Date(deadline).toISOString() : null,
        mode,
      })
      // Trello → Classic: spread cards/lists into a grid instead of piling at (0,0).
      if (modeChanged && board.mode === 'trello' && mode === 'classic') {
        await layoutBoardGrid(board.id)
      }
      onUpdate(updated)
      // A mode change swaps the whole board view (server component) — refresh to
      // re-render with the right view and freshly-laid-out positions.
      if (modeChanged) router.refresh()
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

      <label className="block text-xs text-gray-600 mb-1.5 flex items-center gap-1">
        Board preset
        {textLocked && <Lock size={10} className="text-gray-400" />}
      </label>
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        {(['classic', 'trello', 'text', 'folder'] as const).map(m => (
          <button
            key={m}
            disabled={textLocked}
            onClick={() => setMode(m)}
            className={`py-2 rounded text-xs font-medium border capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${mode === m ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
          >
            {m === 'classic' ? '🎨 Classic' : m === 'trello' ? '🗂 Trello' : m === 'text' ? '📝 Text' : '📁 Folder'}
          </button>
        ))}
      </div>
      {textLocked ? (
        <p className="text-[10px] text-gray-400 mb-3 flex items-center gap-1"><Lock size={9} /> Text tabs stay text — mode is locked.</p>
      ) : (
        <>
          {mode === 'classic' && <p className="text-[10px] text-gray-400 mb-3">Freeform canvas — drag anything, draw connections.</p>}
          {mode === 'trello' && <p className="text-[10px] text-gray-400 mb-3">Kanban columns and cards.</p>}
          {mode === 'text' && <p className="text-[10px] text-gray-400 mb-3">Document — a plain writing space, auto-saved.</p>}
          {mode === 'folder' && <p className="text-[10px] text-gray-400 mb-3">File explorer — sub-folders and dropped text files.</p>}
        </>
      )}

      {warnings.length > 0 && (
        <div className="mb-3 p-2 rounded bg-amber-50 border border-amber-200">
          <p className="text-[10px] font-semibold text-amber-700 flex items-center gap-1 mb-1">
            <AlertTriangle size={11} /> Heads up
          </p>
          <ul className="text-[10px] text-amber-700 list-disc pl-3.5 space-y-0.5">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <button onClick={handleSave} disabled={saving} className={`w-full text-white text-sm py-1.5 rounded disabled:opacity-60 ${warnings.length > 0 ? 'bg-amber-600 hover:bg-amber-700' : 'bg-[#0079bf] hover:bg-[#026aa7]'}`}>
        {saving ? 'Saving…' : warnings.length > 0 ? 'Switch anyway' : 'Save'}
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
