'use client'

import { useState, useTransition, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Plus, ChevronDown, X, Trash2 } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard, deleteBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'
import BoardPropertiesPanel from './BoardPropertiesPanel'

const MODE_EMOJI: Record<Board['mode'], string> = {
  classic: '🎨',
  trello: '🗂',
  text: '📝',
  folder: '📁',
  database: '🗄️',
}

const byPos = (a: Board, b: Board) =>
  a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at)

type OpenPanel = { board: Board; rect: DOMRect } | null

export default function BoardsHome({ boards: initialBoards }: { boards: Board[] }) {
  const [showModal, setShowModal] = useState(false)
  const [, startTransition] = useTransition()
  const router = useRouter()
  const [boards, setBoards] = useState(initialBoards)
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [pendingDelete, setPendingDelete] = useState<Board | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Active persona — derived from the remembered pointer (set by the TabBar when
  // inside a board), falling back to the first persona. Null = legacy data.
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null)
  useEffect(() => {
    const personas = boards.filter(b => b.is_persona)
    let pid: string | null = null
    try { pid = localStorage.getItem('activePersonaId') } catch {}
    if (!pid || !personas.some(p => p.id === pid)) pid = personas[0]?.id ?? null
    setActivePersonaId(pid)
  }, [boards])

  const { roots, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string, Board[]>()
    for (const b of boards) {
      if (b.parent_id) {
        const arr = childrenOf.get(b.parent_id) ?? []
        arr.push(b)
        childrenOf.set(b.parent_id, arr)
      }
    }
    for (const arr of childrenOf.values()) arr.sort(byPos)
    // Only the active persona's top-level boards (never personas themselves).
    const roots = boards.filter(b => !b.is_persona && b.parent_id === activePersonaId).sort(byPos)
    return { roots, childrenOf }
  }, [boards, activePersonaId])

  async function handleDeleteConfirmed() {
    if (!pendingDelete) return
    setDeleting(true)
    const wasActive = typeof window !== 'undefined' && window.location.pathname === `/board/${pendingDelete.id}`
    setBoards(prev => prev.filter(b => b.id !== pendingDelete.id && b.parent_id !== pendingDelete.id))
    setPendingDelete(null)
    setDeleting(false)
    try { await deleteBoard(pendingDelete.id) } catch {}
    if (wasActive) router.push('/boards'); else router.refresh()
  }

  function BoardChip({ board, depth }: { board: Board; depth: number }) {
    const kids = childrenOf.get(board.id) ?? []
    const isRoot = depth === 0
    return (
      <div className={depth > 0 ? 'pl-4 border-l-2 border-gray-200 ml-2' : ''}>
        <div
          className={`relative group/chip rounded-lg shadow-sm ${isRoot ? 'h-20' : 'h-12'}`}
          style={{ backgroundColor: board.color }}
        >
          {/* Main click area */}
          <button
            onClick={() => router.push(`/board/${board.id}`)}
            className={`w-full h-full text-white font-semibold text-left p-3 hover:brightness-90 transition-all flex items-center gap-2 rounded-lg ${isRoot ? '' : 'text-xs'}`}
          >
            <span className={isRoot ? 'text-xl' : 'text-base'}>{MODE_EMOJI[board.mode] ?? '🎨'}</span>
            <span className="truncate flex-1">{board.name}</span>
            {kids.length > 0 && (
              <span className="text-[10px] font-medium bg-black/20 rounded-full px-2 py-0.5 shrink-0">
                {kids.length} tab{kids.length !== 1 ? 's' : ''}
              </span>
            )}
          </button>

          {/* Hover controls */}
          <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/chip:opacity-100 flex items-center gap-0.5 transition-opacity">
            <button
              onClick={e => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setOpenPanel(prev => prev?.board.id === board.id ? null : { board, rect })
              }}
              className="p-0.5 rounded bg-black/25 hover:bg-black/45 text-white"
              title="Board properties"
            >
              <ChevronDown size={11} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); setPendingDelete(board) }}
              className="p-0.5 rounded bg-black/25 hover:bg-red-500/80 text-white"
              title="Delete board"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        {kids.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {kids.map(k => <BoardChip key={k.id} board={k} depth={depth + 1} />)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Your boards</h1>

      <div className="grid gap-3 items-start" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {roots.map(board => (
          <BoardChip key={board.id} board={board} depth={0} />
        ))}
        <button
          onClick={() => setShowModal(true)}
          className="h-20 w-full rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-600 font-medium text-sm flex items-center justify-center gap-1.5 transition-colors"
        >
          <Plus size={16} />
          Create new board
        </button>
      </div>

      {openPanel && (
        <BoardPropertiesPanel
          board={openPanel.board}
          anchorRect={openPanel.rect}
          onClose={() => setOpenPanel(null)}
          onUpdate={updated => {
            setBoards(prev => prev.map(b => b.id === updated.id ? updated : b))
            setOpenPanel(null)
            router.refresh()
          }}
          onRemove={() => {
            if (openPanel.board.is_persona) return
            setOpenPanel(null)
            setPendingDelete(openPanel.board)
          }}
        />
      )}

      {showModal && (
        <NewBoardModal
          onClose={() => setShowModal(false)}
          onCreate={(name, color, mode) => {
            startTransition(async () => {
              const board = await createBoard(name, color, mode, activePersonaId)
              setBoards(prev => [...prev, board])
              setShowModal(false)
              router.push(`/board/${board.id}`)
            })
          }}
        />
      )}

      {pendingDelete && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
          onClick={() => !deleting && setPendingDelete(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl border border-gray-200 p-5 w-80 mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="shrink-0 w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
                <Trash2 size={15} className="text-red-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">Delete &ldquo;{pendingDelete.name}&rdquo;?</p>
                <p className="text-xs text-gray-500 mt-1">This will permanently delete this board, all its sub-tabs, and every unit inside them. This cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="flex-1 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirmed}
                disabled={deleting}
                className="flex-1 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
