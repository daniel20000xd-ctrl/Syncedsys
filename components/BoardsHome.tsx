'use client'

import { useState, useTransition, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'

const MODE_EMOJI: Record<Board['mode'], string> = {
  classic: '🎨',
  trello: '🗂',
  text: '📝',
  folder: '📁',
}

const byPos = (a: Board, b: Board) =>
  a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at)

export default function BoardsHome({ boards }: { boards: Board[] }) {
  const [showModal, setShowModal] = useState(false)
  const [, startTransition] = useTransition()
  const router = useRouter()

  // Build the parent → children index once.
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
    // A root is any board whose parent isn't itself in the list (top-level, or
    // an orphan whose parent was deleted — shown rather than hidden).
    const ids = new Set(boards.map(b => b.id))
    const roots = boards.filter(b => !b.parent_id || !ids.has(b.parent_id)).sort(byPos)
    return { roots, childrenOf }
  }, [boards])

  // One board chip. `depth` controls indentation/size of nested subtabs.
  function BoardChip({ board, depth }: { board: Board; depth: number }) {
    const kids = childrenOf.get(board.id) ?? []
    const isRoot = depth === 0
    return (
      <div className={depth > 0 ? 'pl-4 border-l-2 border-gray-200 ml-2' : ''}>
        <button
          onClick={() => router.push(`/board/${board.id}`)}
          className={`relative w-full rounded-lg text-white font-semibold text-left p-3 hover:brightness-90 transition-all shadow-sm flex items-center gap-2 ${isRoot ? 'h-20' : 'h-12 text-xs'}`}
          style={{ backgroundColor: board.color }}
        >
          <span className={isRoot ? 'text-xl' : 'text-base'}>{MODE_EMOJI[board.mode] ?? '🎨'}</span>
          <span className="truncate flex-1">{board.name}</span>
          {kids.length > 0 && (
            <span className="text-[10px] font-medium bg-black/20 rounded-full px-2 py-0.5 shrink-0">
              {kids.length} tab{kids.length !== 1 ? 's' : ''}
            </span>
          )}
        </button>
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5 items-start">
        {roots.map(board => (
          <BoardChip key={board.id} board={board} depth={0} />
        ))}
        <button
          onClick={() => setShowModal(true)}
          className="h-20 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-600 font-medium text-sm flex items-center justify-center gap-1.5 transition-colors"
        >
          <Plus size={16} />
          Create new board
        </button>
      </div>

      {showModal && (
        <NewBoardModal
          onClose={() => setShowModal(false)}
          onCreate={(name, color, mode) => {
            startTransition(async () => {
              const board = await createBoard(name, color, mode)
              setShowModal(false)
              router.push(`/board/${board.id}`)
            })
          }}
        />
      )}
    </div>
  )
}
