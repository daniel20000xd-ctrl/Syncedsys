'use client'

import { useState } from 'react'
import { X } from 'lucide-react'

const COLORS = [
  '#0079bf', '#d29034', '#519839', '#b04632',
  '#89609e', '#cd5a91', '#4bbf6b', '#00aecc',
  '#344563', '#f2d600',
]

export default function NewBoardModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (name: string, color: string) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onCreate(name.trim(), color)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-80 p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-800">Create board</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Color preview */}
        <div
          className="w-full h-24 rounded-lg mb-4 transition-colors"
          style={{ backgroundColor: color }}
        />

        {/* Color picker */}
        <div className="grid grid-cols-5 gap-1.5 mb-4">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`h-8 rounded transition-transform hover:scale-105 ${color === c ? 'ring-2 ring-offset-1 ring-gray-800' : ''}`}
              style={{ backgroundColor: c }}
            />
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
