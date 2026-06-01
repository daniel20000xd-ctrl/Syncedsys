'use client'

import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Pencil, X, Check, Clock } from 'lucide-react'
import type { Card } from '@/lib/types'
import { deleteCard, updateCard, updateCardDone, setCardDeadline } from '@/app/actions'

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
  const [deadlineValue, setDeadlineValue] = useState(card.deadline ? card.deadline.slice(0, 10) : '')

  const expired = card.deadline ? new Date(card.deadline) < new Date() : false

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

  async function handleSaveDeadline() {
    const iso = deadlineValue ? new Date(deadlineValue).toISOString() : null
    await setCardDeadline(card.id, iso, boardId)
    onUpdated({ ...card, deadline: iso })
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
        <div className="mt-2 border-t border-gray-100 pt-2">
          <p className="text-[10px] text-gray-400 mb-1 flex items-center gap-1"><Clock size={10} /> Expiry (deletes automatically)</p>
          <div className="flex gap-1">
            <input
              type="date"
              value={deadlineValue}
              onChange={e => setDeadlineValue(e.target.value)}
              onBlur={handleSaveDeadline}
              className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            />
            {deadlineValue && (
              <button
                onClick={async () => { setDeadlineValue(''); await setCardDeadline(card.id, null, boardId); onUpdated({ ...card, deadline: null }) }}
                className="text-gray-400 hover:text-red-500 px-1"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button onClick={handleSave} className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-xs px-2 py-1 rounded">Save</button>
          <button onClick={() => { setTitle(card.title); setEditing(false) }} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
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

      <div className="flex-1 pr-5 min-w-0">
        <span className={done ? 'line-through text-gray-400' : ''}>{card.title}</span>
        {card.deadline && (
          <span className={`ml-1.5 text-[10px] font-medium ${expired ? 'text-red-500' : 'text-amber-500'}`}>
            <Clock size={9} className="inline mr-0.5" />
            {expired ? 'Expired' : new Date(card.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

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
