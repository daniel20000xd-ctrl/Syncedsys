'use client'

import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Pencil, X, Check, Clock, Repeat } from 'lucide-react'
import type { Card } from '@/lib/types'
import { recurLabel } from '@/lib/recur'
import { deleteCard, updateCard, updateCardDone, setCardDeadline, setCardRecur } from '@/app/actions'

export default function CardItem({
  card,
  boardId,
  isWidget = false,
  onDeleted,
  onUpdated,
}: {
  card: Card
  boardId: string
  isWidget?: boolean
  onDeleted: (id: string) => void
  onUpdated: (card: Card) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(card.title)
  const [done, setDone] = useState(card.done)
  const [hovered, setHovered] = useState(false)
  const [deadlineValue, setDeadlineValue] = useState(card.deadline ? card.deadline.slice(0, 10) : '')
  // Schedule editor: a card is either 'expire' (deleted at deadline) or 'repeat'
  // (done resets every interval). These are mutually exclusive.
  const [schedMode, setSchedMode] = useState<'none' | 'expire' | 'repeat'>(
    card.deadline ? 'expire' : card.recur_interval_minutes ? 'repeat' : 'none'
  )
  const initialRecur = card.recur_interval_minutes ?? 1440
  const [recurEvery, setRecurEvery] = useState(initialRecur % 1440 === 0 ? initialRecur / 1440 : initialRecur % 60 === 0 ? initialRecur / 60 : initialRecur)
  const [recurUnit, setRecurUnit] = useState<'minutes' | 'hours' | 'days'>(
    card.recur_interval_minutes == null
      ? 'days'
      : card.recur_interval_minutes % 1440 === 0 ? 'days' : card.recur_interval_minutes % 60 === 0 ? 'hours' : 'minutes'
  )

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
    onUpdated({ ...card, deadline: iso, recur_interval_minutes: iso ? null : card.recur_interval_minutes })
  }

  const recurMinutes = Math.max(1, Math.round(recurEvery)) * (recurUnit === 'days' ? 1440 : recurUnit === 'hours' ? 60 : 1)

  // Persist immediately from explicit values — no reliance on blur timing, so
  // the saved interval always matches what the inputs show.
  function persistRecur(every: number, unit: 'minutes' | 'hours' | 'days') {
    if (!Number.isFinite(every) || every < 1) return
    const mins = Math.round(every) * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1)
    onUpdated({ ...card, recur_interval_minutes: mins, deadline: null })
    setCardRecur(card.id, mins, boardId).catch(err => console.error('Failed to save recurrence:', err))
  }

  async function clearSchedule() {
    setSchedMode('none')
    setDeadlineValue('')
    if (card.deadline) await setCardDeadline(card.id, null, boardId)
    if (card.recur_interval_minutes) await setCardRecur(card.id, null, boardId)
    onUpdated({ ...card, deadline: null, recur_interval_minutes: null })
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
          {/* Schedule type toggle: none / expire / repeat */}
          <div className="flex gap-1 mb-2 text-[10px]">
            {([
              ['none', 'None'],
              ['expire', 'Expire'],
              ['repeat', 'Repeat'],
            ] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => {
                  if (m === 'none') { clearSchedule() }
                  else if (m === 'repeat') { setSchedMode('repeat'); if (card.recur_interval_minutes == null) persistRecur(recurEvery, recurUnit) }
                  else { setSchedMode('expire') }
                }}
                className={`flex-1 py-1 rounded border transition-colors ${
                  schedMode === m
                    ? 'bg-[#0079bf] border-[#0079bf] text-white'
                    : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {schedMode === 'expire' && (
            <div>
              <p className="text-[10px] text-gray-400 mb-1 flex items-center gap-1"><Clock size={10} /> Deletes automatically on this date</p>
              <input
                type="date"
                value={deadlineValue}
                onChange={e => setDeadlineValue(e.target.value)}
                onBlur={handleSaveDeadline}
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
          )}

          {schedMode === 'repeat' && (
            <div>
              <p className="text-[10px] text-gray-400 mb-1 flex items-center gap-1"><Repeat size={10} /> Re-opens itself for completion</p>
              <div className="flex gap-1 items-center">
                <span className="text-[11px] text-gray-500">Every</span>
                <input
                  type="number"
                  min={1}
                  value={recurEvery}
                  onChange={e => { const v = Number(e.target.value); setRecurEvery(v); persistRecur(v, recurUnit) }}
                  className="w-14 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
                />
                <select
                  value={recurUnit}
                  onChange={e => { const u = e.target.value as 'minutes' | 'hours' | 'days'; setRecurUnit(u); persistRecur(recurEvery, u) }}
                  className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 bg-white"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">{recurLabel(recurMinutes)} · resets to undone</p>
            </div>
          )}
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
      className={`relative bg-white rounded-lg shadow-sm border border-transparent hover:border-blue-300 p-2 text-sm text-gray-800 cursor-grab active:cursor-grabbing group flex items-start gap-2 transition-opacity duration-500 ${done && isWidget ? 'opacity-50' : ''}`}
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
        {card.recur_interval_minutes != null && (
          <span className="ml-1.5 text-[10px] font-medium text-indigo-500" title={`Repeats ${recurLabel(card.recur_interval_minutes).toLowerCase()}`}>
            <Repeat size={9} className="inline mr-0.5" />
            {recurLabel(card.recur_interval_minutes)}
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
