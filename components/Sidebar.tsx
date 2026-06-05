'use client'

import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, LogOut, List, Settings, LayoutDashboard } from 'lucide-react'
import type { Board, List as ListType } from '@/lib/types'
import { useUnits } from '@/lib/unitsStore'
import { useDocTabs } from '@/lib/docTabsStore'
import { useFolderUnits } from '@/lib/folderUnitsStore'
import UnitsPanel from './UnitsPanel'
import DocTabsPanel from './DocTabsPanel'
import FolderUnitsPanel from './FolderUnitsPanel'

export default function Sidebar({ boards, isAdmin }: { boards: Board[]; userId: string; isAdmin?: boolean; devices?: unknown[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [lists, setLists] = useState<ListType[]>([])

  const boardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  const activeBoard = boards.find(b => b.id === boardId)
  const units = useUnits()
  const docTabs = useDocTabs()
  const folderUnits = useFolderUnits()
  const showUnits = units.length > 0
  const showDocTabs = !showUnits && docTabs.tabs.length > 0
  const showFolderUnits = !showUnits && !showDocTabs && folderUnits.length > 0
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
        {!collapsed && <span className="font-bold text-base tracking-tight text-white">Syncedsys</span>}
        <button onClick={() => setCollapsed(!collapsed)} className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>

      {/* Dashboard: units (or lists) — scrollable top half, reserved space below */}
      <nav className="flex-1 flex flex-col min-h-0 py-2">
        {!collapsed && (
          <div className="px-3 py-1 mb-1 shrink-0">
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">
              {showUnits ? `${activeBoard?.name ?? 'Board'} · units`
                : showDocTabs ? `${activeBoard?.name ?? 'Board'} · pages`
                : showFolderUnits ? `${activeBoard?.name ?? 'Board'} · items`
                : (activeBoard ? activeBoard.name : 'Lists')}
            </span>
          </div>
        )}

        {/* Units area — capped at ~half viewport height, scrolls within */}
        <div className="overflow-y-auto shrink-0" style={{ maxHeight: 'calc(50vh - 42px)' }}>
          {!collapsed && showUnits && <UnitsPanel />}
          {!collapsed && showDocTabs && <DocTabsPanel />}
          {!collapsed && showFolderUnits && <FolderUnitsPanel />}

          {!collapsed && !showUnits && !showDocTabs && !showFolderUnits && lists.length === 0 && boardId && (
            <p className="px-3 py-1 text-xs text-white/30">No lists yet</p>
          )}
          {!collapsed && !showUnits && !showDocTabs && !showFolderUnits && lists.length === 0 && !boardId && (
            <p className="px-3 py-1 text-xs text-white/30">Open a board</p>
          )}
          {!collapsed && !showUnits && !showDocTabs && !showFolderUnits && lists.map(list => (
            <button
              key={list.id}
              onClick={() => scrollToList(list.id)}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title={list.name}
            >
              <List size={14} className="shrink-0" />
              <span className="truncate text-left">{list.name}</span>
            </button>
          ))}
        </div>

        {/* Divider — bottom half reserved for future functions */}
        {!collapsed && <div className="mt-2 border-t border-white/10 flex-1" />}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 p-2 space-y-0.5">
        {isAdmin && (
          <button
            onClick={() => router.push('/admin')}
            className={`w-full flex items-center gap-2 px-2 py-2 rounded text-sm transition-colors ${pathname === '/admin' ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'} ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? 'Admin Console' : undefined}
          >
            <LayoutDashboard size={15} />
            {!collapsed && <span>Admin Console</span>}
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
