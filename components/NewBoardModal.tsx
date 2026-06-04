'use client'

import { useState } from 'react'
import { X, Check } from 'lucide-react'

const COLORS = [
  '#0079bf', '#d29034', '#519839', '#b04632',
  '#89609e', '#cd5a91', '#4bbf6b', '#00aecc',
  '#344563', '#f2d600',
]

const MODES = [
  { id: 'classic',     emoji: '🎨', label: 'Canvas',      desc: 'Freeform — drag anything, draw connections' },
  { id: 'trello',      emoji: '🗂',  label: 'Kanban',      desc: 'Columns and cards, Trello-style' },
  { id: 'text',        emoji: '📝', label: 'Document',    desc: 'Writing space with pages, auto-saved' },
  { id: 'folder',      emoji: '📁', label: 'Folder',      desc: 'File-explorer view with sub-folders' },
] as const

type Mode = typeof MODES[number]['id']

export default function NewBoardModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (name: string, color: string, mode: Mode) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [mode, setMode] = useState<Mode>('classic')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onCreate(name.trim(), color, mode)
  }

  const selectedMode = MODES.find(m => m.id === mode)!

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-80 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-800">Create board</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {/* Color preview */}
        <div className="w-full h-16 rounded-lg mb-3 transition-colors flex items-end px-3 pb-2" style={{ backgroundColor: color }}>
          <span className="text-white/90 text-lg">{selectedMode.emoji}</span>
        </div>

        {/* Color picker */}
        <div className="grid grid-cols-5 gap-1.5 mb-4">
          {COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              className={`h-7 rounded transition-transform hover:scale-105 ${color === c ? 'ring-2 ring-offset-1 ring-gray-800' : ''}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        {/* Mode selector */}
        <p className="text-xs text-gray-500 font-medium mb-1.5">Type</p>
        <div className="flex flex-col gap-1 mb-4">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left border transition-colors ${
                mode === m.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <span className="text-base shrink-0">{m.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${mode === m.id ? 'text-blue-700' : 'text-gray-700'}`}>{m.label}</p>
                <p className="text-[10px] text-gray-400 truncate">{m.desc}</p>
              </div>
              {mode === m.id && <Check size={14} className="text-blue-500 shrink-0" />}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          <input
            autoFocus
            type="text"
            placeholder="Board title"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="w-full bg-[#0079bf] hover:bg-[#026aa7] text-white font-medium py-2 rounded text-sm disabled:opacity-50"
          >
            Create
          </button>
        </form>
      </div>
    </div>
  )
}
