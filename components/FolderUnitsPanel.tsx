'use client'

import { Folder, FileText } from 'lucide-react'
import { useFolderUnits, folderUnitsStore } from '@/lib/folderUnitsStore'

const MODE_EMOJI: Record<string, string> = { classic: '🎨', trello: '🗂', text: '📝', folder: '📁', spreadsheet: '📊' }

export default function FolderUnitsPanel() {
  const units = useFolderUnits()
  if (units.length === 0) return <p className="px-3 py-1 text-xs text-white/30">Empty folder</p>
  return (
    <div className="px-1">
      {units.map(u => (
        <button
          key={u.id}
          onClick={() => folderUnitsStore.open(u.id, u.kind)}
          className="w-full group flex items-center gap-2 px-1.5 py-1 rounded text-sm text-white/60 hover:bg-white/10 hover:text-white"
          title={u.name}
        >
          {u.kind === 'folder'
            ? <Folder size={14} className="shrink-0 text-blue-300/70" />
            : <FileText size={14} className="shrink-0 text-indigo-300/70" />}
          <span className="truncate flex-1 text-left text-[13px]">{u.name}</span>
          {u.kind === 'folder' && u.mode && u.mode !== 'folder' && <span className="text-[10px] opacity-60">{MODE_EMOJI[u.mode] ?? ''}</span>}
        </button>
      ))}
    </div>
  )
}
