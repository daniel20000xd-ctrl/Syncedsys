'use client'

import { useEffect, useCallback, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, LayoutGrid, ChevronDown } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'
import BoardPropertiesPanel from './BoardPropertiesPanel'

function isExpired(board: Board) {
  return !!board.deadline && new Date(board.deadline) < new Date()
}

type OpenPanel = { boardId: string; rect: DOMRect } | null

export default function TabBar({ boards: initialBoards }: { boards: Board[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [boards, setBoards] = useState(initialBoards)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)

  const rootBoards = boards.filter(b => !b.parent_id)
  const activeBoardIndex = rootBoards.findIndex(b => pathname === `/board/${b.id}`)

  const goToTab = useCallback((index: number) => {
    if (rootBoards.length === 0) return
    const clamped = (index + rootBoards.length) % rootBoards.length
    router.push(`/board/${rootBoards[clamped].id}`)
  }, [rootBoards, router])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return
      if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); goToTab(activeBoardIndex - 1) }
      if (e.key === 'w' || e.key === 'W') { e.preventDefault(); goToTab(activeBoardIndex + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeBoardIndex, goToTab])

  useEffect(() => { setBoards(initialBoards) }, [initialBoards])

  const isAllBoards = pathname === '/boards'

  return (
    <>
      <div className="flex items-end bg-[#1d2125] border-b border-white/10 overflow-x-auto shrink-0 px-1">
        <Link
          href="/boards"
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm whitespace-nowrap border-t-2 transition-colors select-none shrink-0 ${
            isAllBoards ? 'bg-white/10 text-white border-[#579dff]' : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
          }`}
        >
          <LayoutGrid size={14} />
          All boards
        </Link>

        {rootBoards.map(board => {
          const isActive = pathname === `/board/${board.id}`
          const expired = isExpired(board)
          return (
            <div key={board.id} className="relative group shrink-0">
              <Link
                href={`/board/${board.id}`}
                className={`flex items-center gap-2 px-4 py-2.5 pr-7 text-sm whitespace-nowrap border-t-2 transition-colors select-none ${
                  isActive ? 'bg-white/10 text-white border-[#579dff]'
                  : expired ? 'text-red-400/70 border-red-500/40 hover:text-red-300 hover:bg-white/5'
                  : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: board.color }} />
                {board.name}
                {expired && <span className="text-[10px] text-red-400 ml-1">Expired</span>}
              </Link>
              <button
                onClick={e => {
                  e.preventDefault()
                  const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                  setOpenPanel(openPanel?.boardId === board.id ? null : { boardId: board.id, rect })
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/20 text-white/50 hover:text-white transition-opacity"
                title="Edit board"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          )
        })}

        <button
          onClick={() => setShowNewBoard(true)}
          className="flex items-center gap-1.5 px-3 py-2.5 text-white/40 hover:text-white/70 text-sm whitespace-nowrap border-t-2 border-transparent shrink-0"
          title="New board"
        >
          <Plus size={14} />
        </button>
      </div>

      {openPanel && (() => {
        const board = boards.find(b => b.id === openPanel.boardId)
        if (!board) return null
        return (
          <BoardPropertiesPanel
            board={board}
            anchorRect={openPanel.rect}
            onClose={() => setOpenPanel(null)}
            onUpdate={updated => {
              setBoards(prev => prev.map(b => b.id === updated.id ? updated : b))
              setOpenPanel(null)
              router.refresh()
            }}
          />
        )
      })()}

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
