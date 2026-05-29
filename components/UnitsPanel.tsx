'use client'

import { useState } from 'react'
import { GripVertical, Settings2, List as ListIcon, Square, Type, Image as ImageIcon, Pencil, CreditCard, Folder, Frame } from 'lucide-react'
import { useUnits, unitsStore, type Unit } from '@/lib/unitsStore'

const KIND_ICON: Record<Unit['kind'], typeof Square> = {
  list: ListIcon,
  card: CreditCard,
  shape: Square,
  text: Type,
  image: ImageIcon,
  drawing: Pencil,
  subtab: Folder,
  portal: Frame,
  unknown: Square,
}

export default function UnitsPanel() {
  const units = useUnits()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [settingsId, setSettingsId] = useState<string | null>(null)

  if (units.length === 0) {
    return <p className="px-3 py-1 text-xs text-white/30">No units yet</p>
  }

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(null); setOverId(null); return }
    const ids = units.map(u => u.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    unitsStore.reorder(ids) // top of the list = highest layer
    setDragId(null)
    setOverId(null)
  }

  return (
    <div className="px-1">
      <p className="px-2 py-1 text-[9px] text-white/30">Top of list = front layer · drag to reorder</p>
      {units.map(u => {
        const Icon = KIND_ICON[u.kind]
        const isOpen = settingsId === u.id
        return (
          <div key={u.id}>
            <div
              draggable
              onDragStart={() => setDragId(u.id)}
              onDragOver={e => { e.preventDefault(); setOverId(u.id) }}
              onDrop={() => handleDrop(u.id)}
              onDragEnd={() => { setDragId(null); setOverId(null) }}
              onClick={() => unitsStore.select(u.id)}
              className={`group flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer text-sm transition-colors ${
                u.selected ? 'bg-blue-500/30 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
              } ${overId === u.id && dragId ? 'border-t-2 border-blue-400' : 'border-t-2 border-transparent'}`}
            >
              <GripVertical size={12} className="shrink-0 text-white/25 group-hover:text-white/50 cursor-grab" />
              <Icon size={13} className="shrink-0 text-white/50" />
              <span className="truncate flex-1 text-left text-[13px]">{u.label || u.kind}</span>
              {u.opacity < 1 && <span className="text-[9px] text-white/30">{Math.round(u.opacity * 100)}%</span>}
              <button
                onClick={e => { e.stopPropagation(); setSettingsId(isOpen ? null : u.id) }}
                className={`p-0.5 rounded shrink-0 ${isOpen ? 'text-white bg-white/15' : 'text-white/30 hover:text-white opacity-0 group-hover:opacity-100'}`}
                title="Unit settings"
              >
                <Settings2 size={12} />
              </button>
            </div>

            {isOpen && (
              <div className="mx-2 mb-1 mt-0.5 p-2 rounded bg-black/30 border border-white/10">
                <label className="flex items-center justify-between text-[10px] text-white/50 mb-1">
                  <span>Opacity</span>
                  <span>{Math.round(u.opacity * 100)}%</span>
                </label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round(u.opacity * 100)}
                  onChange={e => unitsStore.setOpacity(u.id, Number(e.target.value) / 100)}
                  className="w-full accent-blue-500"
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
