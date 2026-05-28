'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, LayoutGrid, ChevronDown, Check } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard, updateBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'

const COLORS = [
  '#0079bf', '#d29034', '#519839', '#b04632',
  '#89609e', '#cd5a91', '#4bbf6b', '#00aecc',
  '#344563', '#f2d600',
]

function isExpired(board: Board) {
  return !!board.deadline && new Date(board.deadline) < new Date()
}

function BoardPropertiesPanel({
  board,
  onClose,
  onUpdate,
}: {
  board: Board
  onClose: () => void
  onUpdate: (updated: Board) => void
}) {
  const [name, setName] = useState(board.name)
  const [color, setColor] = useState(board.color)
  const [hasDeadline, setHasDeadline] = useState(!!board.deadline)
  const [deadline, setDeadline] = useState(
    board.deadline ? board.deadline.slice(0, 10) : ''
  )
  const [saving, setSaving] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [onClose])

  async function handleSave() {
    setSaving(true)
    const updated = await updateBoard(board.id, {
      name: name.trim() || board.name,
      color,
      deadline: hasDeadline && deadline ? new Date(deadline).toISOString() : null,
    })
    onUpdate(updated)
    setSaving(false)
    onClose()
  }

  return (
    <div
      ref={panelRef}
      className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 p-4 w-64 z-50"
      onClick={e => e.stopPropagation()}
    >
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Board properties</p>

      {/* Name */}
      <label className="block text-xs text-gray-600 mb-1">Name</label>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:border-blue-500"
      />

      {/* Color */}
      <label className="block text-xs text-gray-600 mb-1.5">Color</label>
      <div className="grid grid-cols-5 gap-1.5 mb-3">
        {COLORS.map(c => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className="h-7 rounded transition-transform hover:scale-105 relative"
            style={{ backgroundColor: c }}
          >
            {color === c && (
              <Check size={12} className="absolute inset-0 m-auto text-white drop-shadow" />
            )}
          </button>
        ))}
      </div>

      {/* Deadline */}
      <div className="mb-4">
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none mb-1.5">
          <input
            type="checkbox"
            checked={hasDeadline}
            onChange={e => setHasDeadline(e.target.checked)}
            className="rounded"
          />
          Set expiry date (optional)
        </label>
        {hasDeadline && (
          <input
            type="date"
            value={deadline}
            onChange={e => setDeadline(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
          />
        )}
        {hasDeadline && (
          <p className="text-[10px] text-gray-400 mt-1">Board will be marked expired after this date.</p>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm py-1.5 rounded disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

export default function TabBar({ boards: initialBoards }: { boards: Board[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [boards, setBoards] = useState(initialBoards)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [openPanel, setOpenPanel] = useState<string | null>(null)

  const activeBoardIndex = boards.findIndex(b => pathname === `/board/${b.id}`)

  const goToTab = useCallback((index: number) => {
    if (boards.length === 0) return
    const clamped = (index + boards.length) % boards.length
    router.push(`/board/${boards[clamped].id}`)
  }, [boards, router])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return
      if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); goToTab(activeBoardIndex - 1) }
      if (e.key === 'w' || e.key === 'W') { e.preventDefault(); goToTab(activeBoardIndex + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeBoardIndex, goToTab])

  // Keep boards in sync when layout re-renders with new data
  useEffect(() => { setBoards(initialBoards) }, [initialBoards])

  const isAllBoards = pathname === '/boards'

  return (
    <>
      <div className="flex items-end bg-[#1d2125] border-b border-white/10 overflow-x-auto shrink-0 px-1">

        {/* Home / All Boards tab */}
        <Link
          href="/boards"
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm whitespace-nowrap border-t-2 transition-colors select-none shrink-0 ${
            isAllBoards
              ? 'bg-white/10 text-white border-[#579dff]'
              : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
          }`}
        >
          <LayoutGrid size={14} />
          All boards
        </Link>

        {/* Board tabs */}
        {boards.map((board) => {
          const isActive = pathname === `/board/${board.id}`
          const expired = isExpired(board)

          return (
            <div key={board.id} className="relative group shrink-0">
              <Link
                href={`/board/${board.id}`}
                className={`flex items-center gap-2 px-4 py-2.5 pr-7 text-sm whitespace-nowrap border-t-2 transition-colors select-none ${
                  isActive
                    ? 'bg-white/10 text-white border-[#579dff]'
                    : expired
                    ? 'text-red-400/70 border-red-500/40 hover:text-red-300 hover:bg-white/5'
                    : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: board.color }}
                />
                {board.name}
                {expired && <span className="text-[10px] text-red-400 ml-1">Expired</span>}
              </Link>

              {/* Properties arrow — visible on hover */}
              <button
                onClick={e => { e.preventDefault(); setOpenPanel(openPanel === board.id ? null : board.id) }}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/20 text-white/50 hover:text-white transition-opacity"
                title="Edit board"
              >
                <ChevronDown size={12} />
              </button>

              {/* Properties panel */}
              {openPanel === board.id && (
                <BoardPropertiesPanel
                  board={board}
                  onClose={() => setOpenPanel(null)}
                  onUpdate={updated => {
                    setBoards(prev => prev.map(b => b.id === updated.id ? updated : b))
                    setOpenPanel(null)
                  }}
                />
              )}
            </div>
          )
        })}

        {/* New board button */}
        <button
          onClick={() => setShowNewBoard(true)}
          className="flex items-center gap-1.5 px-3 py-2.5 text-white/40 hover:text-white/70 text-sm whitespace-nowrap border-t-2 border-transparent shrink-0"
          title="New board"
        >
          <Plus size={14} />
        </button>
      </div>

      {showNewBoard && (
        <NewBoardModal
          onClose={() => setShowNewBoard(false)}
          onCreate={async (name, color) => {
            const board = await createBoard(name, color)
            setBoards(prev => [...prev, board])
            setShowNewBoard(false)
            router.push(`/board/${board.id}`)
          }}
        />
      )}
    </>
  )
}
