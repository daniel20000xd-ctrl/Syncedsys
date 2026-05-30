'use client'

import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, LogOut, List, Settings, LayoutGrid, Smartphone, Plus, X } from 'lucide-react'
import type { Board, List as ListType, DeviceLink } from '@/lib/types'
import { useUnits } from '@/lib/unitsStore'
import { createDeviceLink, removeDeviceLink } from '@/app/actions'
import UnitsPanel from './UnitsPanel'

export default function Sidebar({ boards, isAdmin, devices = [] }: { boards: Board[]; userId: string; isAdmin?: boolean; devices?: DeviceLink[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [lists, setLists] = useState<ListType[]>([])
  const [pairing, setPairing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const boardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  const activeBoard = boards.find(b => b.id === boardId)
  const units = useUnits()
  const showUnits = units.length > 0
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

  async function handleConnectApp() {
    if (busy) return
    setBusy(true)
    try {
      const { code } = await createDeviceLink()
      setPairing(code)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveDevice(id: string) {
    await removeDeviceLink(id)
    router.refresh()
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

      {/* Dashboard: units (or lists) above — synced tabs below the divider */}
      <nav className="flex-1 overflow-y-auto py-2">
        {!collapsed && (
          <div className="px-3 py-1 mb-1">
            <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">
              {showUnits ? `${activeBoard?.name ?? 'Board'} · units` : (activeBoard ? activeBoard.name : 'Lists')}
            </span>
          </div>
        )}

        {!collapsed && showUnits && <UnitsPanel />}

        {!collapsed && !showUnits && lists.length === 0 && boardId && (
          <p className="px-3 py-1 text-xs text-white/30">No lists yet</p>
        )}
        {!collapsed && !showUnits && lists.length === 0 && !boardId && (
          <p className="px-3 py-1 text-xs text-white/30">Open a board</p>
        )}
        {!collapsed && !showUnits && lists.map(list => (
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

      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 p-2 space-y-0.5">
        {/* Connected iOS apps — list above Settings */}
        {!collapsed && (
          <div className="mb-1">
            <div className="px-2 py-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Connected apps</span>
              <button onClick={handleConnectApp} disabled={busy} className="p-0.5 rounded hover:bg-white/10 text-white/50 hover:text-white disabled:opacity-40" title="Connect an iOS app">
                <Plus size={13} />
              </button>
            </div>

            {pairing && (
              <div className="mx-1 mb-1 p-2 rounded bg-white/10 border border-white/10">
                <p className="text-[10px] text-white/50 mb-1">Enter this code in the iOS app:</p>
                <p className="font-mono text-base tracking-widest text-white text-center select-all">{pairing}</p>
                <button onClick={() => setPairing(null)} className="mt-1 w-full text-[10px] text-white/40 hover:text-white/70">Done</button>
              </div>
            )}

            {devices.length === 0 && !pairing && (
              <p className="px-2 py-1 text-[11px] text-white/25">No apps connected</p>
            )}
            {devices.map(d => (
              <div key={d.id} className="group flex items-center gap-2 px-2 py-1 rounded text-sm text-white/60 hover:bg-white/10">
                <Smartphone size={14} className="shrink-0" />
                <span className="truncate flex-1 text-[13px]">{d.name}{!d.paired && <span className="text-[10px] text-amber-400/80 ml-1">pending</span>}</span>
                <button onClick={() => handleRemoveDevice(d.id)} className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400" title="Remove">
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className="my-1 border-t border-white/10" />
          </div>
        )}

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
