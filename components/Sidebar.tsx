'use client'

import { useState, useEffect, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, LogOut, List, Settings, LayoutGrid } from 'lucide-react'
import type { Board, List as ListType } from '@/lib/types'

export default function Sidebar({ boards, userId, isAdmin }: { boards: Board[]; userId: string; isAdmin?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [lists, setLists] = useState<ListType[]>([])

  const boardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  const activeBoard = boards.find(b => b.id === boardId)

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

  return (
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
      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 p-2 space-y-0.5">
        {isAdmin && (
          <button
            onClick={() => router.push('/overview')}
            className={`w-full flex items-center gap-2 px-2 py-2 rounded text-sm transition-colors ${pathname === '/overview' ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'} ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? 'Overview' : undefined}
          >
            <LayoutGrid size={15} />
            {!collapsed && <span>Overview</span>}
          </button>
        )}
        <button
          onClick={() => router.push('/settings')}
          className={`w-full flex items-center gap-2 px-2 py-2 rounded text-sm transition-colors ${pathname === '/settings' ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'} ${collapsed ? 'justify-center' : ''}`}
        >
          <Settings size={15} />
          {!collapsed && <span>Settings</span>}
        </button>
        <button
          onClick={handleLogout}
          className={`w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-white/60 hover:bg-white/10 hover:text-white transition-colors ${collapsed ? 'justify-center' : ''}`}
        >
          <LogOut size={15} />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </aside>
  )
}
