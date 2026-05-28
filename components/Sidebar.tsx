'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, LayoutDashboard, ChevronLeft, ChevronRight, LogOut } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'

const BOARD_COLORS = [
  '#0079bf', '#d29034', '#519839', '#b04632',
  '#89609e', '#cd5a91', '#4bbf6b', '#00aecc',
]

export default function Sidebar({ boards, userId }: { boards: Board[]; userId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function handleLogout() {
    const { createClient: makeClient } = await import('@/lib/supabase/client')
    const supabase = makeClient()
    await supabase.auth.signOut()
    router.push('/login')
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
          {/* Boards label */}
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
            return (
              <Link
                key={board.id}
                href={`/board/${board.id}`}
                className={`flex items-center gap-2.5 px-3 py-2 mx-1 rounded text-sm transition-colors ${
                  isActive ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                } ${collapsed ? 'justify-center' : ''}`}
                title={collapsed ? board.name : undefined}
              >
                <span
                  className="w-6 h-6 rounded shrink-0"
                  style={{ backgroundColor: board.color }}
                />
                {!collapsed && (
                  <span className="truncate">{board.name}</span>
                )}
              </Link>
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
              setShowNewBoard(false)
              router.push(`/board/${board.id}`)
            })
          }}
        />
      )}
    </>
  )
}
