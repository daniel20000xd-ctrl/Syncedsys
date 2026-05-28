'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, ChevronLeft, ChevronRight, LogOut, X } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard, deleteBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'

export default function Sidebar({ boards: initialBoards, userId }: { boards: Board[]; userId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [boards, setBoards] = useState(initialBoards)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  async function handleLogout() {
    const { createClient: makeClient } = await import('@/lib/supabase/client')
    const supabase = makeClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  async function handleDelete(boardId: string) {
    setBoards(prev => prev.filter(b => b.id !== boardId))
    setConfirmDelete(null)
    await deleteBoard(boardId)
    if (pathname === `/board/${boardId}`) {
      router.push('/boards')
    }
  }

  return (
    <>
      <aside
        className={`relative flex flex-col bg-[#1d2125] text-white transition-all duration-200 ${
          collapsed ? 'w-12' : 'w-60'
        } shrink-0 h-screen sticky top-0`}
      >
        {/* Header */}
        <div className={`flex items-center h-14 px-3 border-b border-white/10 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && (
            <span className="font-bold text-lg tracking-tight text-white">Syncedsys</span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2">
          {!collapsed && (
            <div className="px-3 py-1 flex items-center justify-between">
              <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Your boards</span>
              <button
                onClick={() => setShowNewBoard(true)}
                className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white"
                title="Create board"
              >
                <Plus size={14} />
              </button>
            </div>
          )}

          {collapsed && (
            <button
              onClick={() => setShowNewBoard(true)}
              className="w-full flex justify-center py-2 hover:bg-white/10 text-white/60 hover:text-white"
              title="Create board"
            >
              <Plus size={16} />
            </button>
          )}

          {boards.map(board => {
            const isActive = pathname === `/board/${board.id}`
            const isConfirming = confirmDelete === board.id

            return (
              <div key={board.id} className="relative mx-1 group">
                {isConfirming ? (
                  /* Inline confirm row */
                  <div className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-red-900/40">
                    <span className="flex-1 text-xs text-white/80 truncate">Delete &ldquo;{board.name}&rdquo;?</span>
                    <button
                      onClick={() => handleDelete(board.id)}
                      className="text-xs bg-red-500 hover:bg-red-600 text-white px-2 py-0.5 rounded"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="text-white/50 hover:text-white"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <Link
                    href={`/board/${board.id}`}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors ${
                      isActive ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                    } ${collapsed ? 'justify-center' : 'pr-8'}`}
                    title={collapsed ? board.name : undefined}
                  >
                    <span
                      className="w-6 h-6 rounded shrink-0"
                      style={{ backgroundColor: board.color }}
                    />
                    {!collapsed && <span className="truncate">{board.name}</span>}
                  </Link>
                )}

                {/* Delete button — shows on hover */}
                {!collapsed && !isConfirming && (
                  <button
                    onClick={e => { e.preventDefault(); setConfirmDelete(board.id) }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/20 text-white/50 hover:text-white transition-opacity"
                    title="Delete board"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            )
          })}

          {boards.length === 0 && !collapsed && (
            <p className="px-3 py-2 text-xs text-white/40">No boards yet</p>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/10 p-2">
          <button
            onClick={handleLogout}
            className={`w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-white/60 hover:bg-white/10 hover:text-white transition-colors ${collapsed ? 'justify-center' : ''}`}
          >
            <LogOut size={16} />
            {!collapsed && <span>Log out</span>}
          </button>
        </div>
      </aside>

      {showNewBoard && (
        <NewBoardModal
          onClose={() => setShowNewBoard(false)}
          onCreate={async (name, color) => {
            startTransition(async () => {
              const board = await createBoard(name, color)
              setBoards(prev => [...prev, board])
              setShowNewBoard(false)
              router.push(`/board/${board.id}`)
            })
          }}
        />
      )}
    </>
  )
}
