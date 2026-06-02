'use client'

import { useState } from 'react'
import { FileText, Plus, MoreHorizontal, Trash2, Pencil } from 'lucide-react'
import { useDocTabs, docTabsStore } from '@/lib/docTabsStore'

export default function DocTabsPanel() {
  const { tabs, active, kind } = useDocTabs()
  const [menuId, setMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [value, setValue] = useState('')

  const noun = kind === 'spreadsheet' ? 'sheet' : 'page'

  return (
    <div className="px-1">
      {tabs.map(t => (
        <div key={t.id} className={`group flex items-center gap-1.5 px-1.5 py-1 rounded text-sm ${active === t.id ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}>
          <FileText size={13} className="shrink-0 text-white/40" />
          {renamingId === t.id ? (
            <input
              autoFocus
              value={value}
              onChange={e => setValue(e.target.value)}
              onBlur={() => { docTabsStore.rename(t.id, value.trim() || t.name); setRenamingId(null) }}
              onKeyDown={e => { if (e.key === 'Enter') { docTabsStore.rename(t.id, value.trim() || t.name); setRenamingId(null) } if (e.key === 'Escape') setRenamingId(null) }}
              className="flex-1 min-w-0 bg-black/30 border border-white/20 rounded px-1 text-[13px] text-white focus:outline-none"
            />
          ) : (
            <button onClick={() => docTabsStore.select(t.id)} className="flex-1 min-w-0 truncate text-left text-[13px]">{t.name}</button>
          )}
          <div className="relative">
            <button
              onClick={() => setMenuId(menuId === t.id ? null : t.id)}
              className={`p-0.5 rounded shrink-0 ${menuId === t.id ? 'text-white bg-white/15' : 'text-white/30 hover:text-white opacity-0 group-hover:opacity-100'}`}
            >
              <MoreHorizontal size={13} />
            </button>
            {menuId === t.id && (
              <div className="absolute right-0 top-6 z-20 bg-white rounded-lg shadow-xl border border-gray-200 py-1 w-32 text-sm">
                <button onClick={() => { setRenamingId(t.id); setValue(t.name); setMenuId(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-100 text-left">
                  <Pencil size={12} /> Rename
                </button>
                {tabs.length > 1 && (
                  <button onClick={() => { docTabsStore.remove(t.id); setMenuId(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-red-600 hover:bg-gray-100 text-left">
                    <Trash2 size={12} /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <button onClick={() => docTabsStore.add()} className="w-full flex items-center gap-2 px-1.5 py-1 mt-0.5 rounded text-[13px] text-white/40 hover:text-white hover:bg-white/10">
        <Plus size={13} /> New {noun}
      </button>
    </div>
  )
}
