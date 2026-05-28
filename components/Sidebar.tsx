'use client'

import { useState, useEffect, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, ChevronLeft, ChevronRight, LogOut, X, List } from 'lucide-react'
import type { Board, List as ListType } from '@/lib/types'
import { createBoard, deleteBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'

export default function Sidebar({ boards: initialBoards, userId }: { boards: Board[]; userId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [boards, setBoards] = useState(initialBoards)
  const [lists, setLists] = useState<ListType[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const boardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  const activeBoard = boards.find(b => b.id === boardId)

  // Fetch lists for current board
  useEffect(() => {
    if (!boardId) { setLists([]); return }
    import('@/lib/supabase/client').then(({ createClient }) => {
      const supabase = createClient()
      supabase
        .from('lists')
        .select('*')
        .eq('board_id', boardId)
        .order('position', { ascending: true })
        .then(({ data }) => setLists(data ?? []))
    })
  }, [boardId])

  function scrollToList(listId: string) {
    const el = document.getElementById(`list-${listId}`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  async function handleLogout() {
    const { createClient: makeClient } = await import('@/lib/supabase/client')
    const supabase = makeClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  async function handleDelete(id: string) {
    setBoards(prev => prev.filter(b => b.id !== id))
    setConfirmDelete(null)
    await deleteBoard(id)
    if (pathname === `/board/${id}`) router.push('/boards')
  }

  return (
    <>
      <aside
        className={`relative flex flex-col bg-[#1d2125] text-white transition-all duration-200 ${
          collapsed ? 'w-12' : 'w-56'
        } shrink-0 h-screen sticky top-0`}
      >
        {/* Header */}
        <div className={`flex items-center h-[42px] px-3 border-b border-white/10 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && (
            <span className="font-bold text-base tracking-tight text-white">Syncedsys</span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white"
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        </div>

        {/* Lists of current board */}
        <nav className="flex-1 overflow-y-auto py-2">
          {!collapsed && (
            <div className="px-3 py-1 mb-1">
              <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">
                {activeBoard ? activeBoard.name : 'Lists'}
              </span>
            </div>
          )}

          {lists.length === 0 && !collapsed && boardId && (
            <p className="px-3 py-1 text-xs text-white/30">No lists yet</p>
          )}

          {lists.length === 0 && !collapsed && !boardId && (
            <p className="px-3 py-1 text-xs text-white/30">Open a board</p>
          )}

          {lists.map(list => (
            <button
              key={list.id}
              onClick={() => scrollToList(list.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-white/60 hover:text-white hover:bg-white/10 transition-colors ${collapsed ? 'justify-center' : ''}`}
              title={collapsed ? list.name : undefined}
            >
              <List size={14} className="shrink-0" />
              {!collapsed && <span className="truncate text-left">{list.name}</span>}
            </button>
          ))}

          {/* Divider + boards section */}
          {!collapsed && (
            <div className="mt-3 pt-2 border-t border-white/10">
              <div className="px-3 py-1 flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Boards</span>
                <button
                  onClick={() => setShowNewBoard(true)}
                  className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white"
                >
                  <Plus size={13} />
                </button>
              </div>

              {boards.map(board => {
                const isActive = boardId === board.id
                const isConfirming = confirmDelete === board.id
                return (
                  <div key={board.id} className="relative group mx-1">
                    {isConfirming ? (
                      <div className="flex items-center gap-1 px-2 py-1 rounded bg-red-900/40">
                        <span className="flex-1 text-xs text-white/80 truncate">Delete?</span>
                        <button onClick={() => handleDelete(board.id)} className="text-xs bg-red-500 hover:bg-red-600 text-white px-1.5 py-0.5 rounded">Yes</button>
                        <button onClick={() => setConfirmDelete(null)} className="text-white/50 hover:text-white"><X size={13} /></button>
                      </div>
                    ) : (
                      <button
                        onClick={() => router.push(`/board/${board.id}`)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors pr-7 ${
                          isActive ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: board.color }} />
                        <span className="truncate">{board.name}</span>
                      </button>
                    )}
                    {!isConfirming && (
                      <button
                        onClick={() => setConfirmDelete(board.id)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/20 text-white/40 hover:text-white transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {collapsed && (
            <button
              onClick={() => setShowNewBoard(true)}
              className="w-full flex justify-center py-2 hover:bg-white/10 text-white/40 hover:text-white mt-2"
            >
              <Plus size={14} />
            </button>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/10 p-2">
          <button
            onClick={handleLogout}
            className={`w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-white/60 hover:bg-white/10 hover:text-white transition-colors ${collapsed ? 'justify-center' : ''}`}
          >
            <LogOut size={15} />
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
