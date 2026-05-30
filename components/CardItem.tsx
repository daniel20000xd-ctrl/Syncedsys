'use client'

import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Pencil, X, Check } from 'lucide-react'
import type { Card } from '@/lib/types'
import { deleteCard, updateCard, updateCardDone } from '@/app/actions'

export default function CardItem({
  card,
  boardId,
  onDeleted,
  onUpdated,
}: {
  card: Card
  boardId: string
  onDeleted: (id: string) => void
  onUpdated: (card: Card) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(card.title)
  const [done, setDone] = useState(card.done)
  const [hovered, setHovered] = useState(false)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  async function handleSave() {
    if (!title.trim()) return
    if (title !== card.title) {
      await updateCard(card.id, { title: title.trim() }, boardId)
      onUpdated({ ...card, title: title.trim() })
    }
    setEditing(false)
  }

  async function handleDelete() {
    await deleteCard(card.id, boardId)
    onDeleted(card.id)
  }

  async function handleToggleDone(e: React.MouseEvent) {
    e.stopPropagation()
    const next = !done
    setDone(next)
    onUpdated({ ...card, done: next })
    await updateCardDone(card.id, next, boardId)
  }

  if (editing) {
    return (
      <div className="bg-white rounded-lg shadow p-2">
        <textarea
          autoFocus
          rows={2}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave() }
            if (e.key === 'Escape') { setTitle(card.title); setEditing(false) }
          }}
          className="w-full text-sm text-gray-800 focus:outline-none resize-none"
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={handleSave}
            className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-xs px-2 py-1 rounded"
          >
            Save
          </button>
          <button
            onClick={() => { setTitle(card.title); setEditing(false) }}
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative bg-white rounded-lg shadow-sm border border-transparent hover:border-blue-300 p-2 text-sm text-gray-800 cursor-grab active:cursor-grabbing group flex items-start gap-2"
    >
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={handleToggleDone}
        className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${done ? 'bg-blue-500 border-blue-500' : 'border-gray-300 hover:border-blue-400'}`}
      >
        {done && <Check size={10} className="text-white" />}
      </button>

      <span className={`flex-1 pr-5 ${done ? 'line-through text-gray-400' : ''}`}>{card.title}</span>

      {hovered && (
        <div className="absolute top-1.5 right-1.5 flex gap-1">
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setEditing(true) }}
            className="p-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-500"
          >
            <Pencil size={12} />
          </button>
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); handleDelete() }}
            className="p-0.5 rounded bg-gray-100 hover:bg-red-100 text-gray-500 hover:text-red-500"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
