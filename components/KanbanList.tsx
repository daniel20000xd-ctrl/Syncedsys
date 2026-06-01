'use client'

import { useState, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { MoreHorizontal, Plus, X, Check, Smartphone, Clock } from 'lucide-react'
import type { List, Card } from '@/lib/types'
import { createCard, deleteCard, deleteList, renameList, setListWidget, setListDeadline } from '@/app/actions'
import CardItem from './CardItem'

// How long a checked card lingers in a widget list before it's removed.
const WIDGET_GRACE_MS = 5000

function isExpired(deadline: string | null) {
  return deadline ? new Date(deadline) < new Date() : false
}

function deadlineLabel(deadline: string | null) {
  if (!deadline) return null
  const d = new Date(deadline)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  if (diffMs < 0) return 'Expired'
  if (diffDays === 0) return 'Expires today'
  if (diffDays === 1) return 'Expires tomorrow'
  return `Expires in ${diffDays}d`
}

export default function KanbanList({
  list,
  cards,
  boardId,
  onCardAdded,
  onCardDeleted,
  onCardUpdated,
  onListDeleted,
  onListRenamed,
}: {
  list: List
  cards: Card[]
  boardId: string
  onCardAdded: (card: Card) => void
  onCardDeleted: (id: string) => void
  onCardUpdated: (card: Card) => void
  onListDeleted: (id: string) => void
  onListRenamed: (id: string, name: string) => void
}) {
  const [addingCard, setAddingCard] = useState(false)
  const [newCardTitle, setNewCardTitle] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState(list.name)
  const [showMenu, setShowMenu] = useState(false)
  const [showExpiryPicker, setShowExpiryPicker] = useState(false)
  const [deadlineValue, setDeadlineValue] = useState(list.deadline ? list.deadline.slice(0, 10) : '')
  const [isWidget, setIsWidget] = useState(list.is_widget)
  const menuRef = useRef<HTMLDivElement>(null)

  // Cards just checked in a widget list stay visible during a short grace
  // period, then leave (one-time → deleted, recurring → hidden until it resets).
  const [graceIds, setGraceIds] = useState<Set<string>>(new Set())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  function handleCardUpdated(card: Card) {
    onCardUpdated(card)
    if (!isWidget) return
    const pending = timersRef.current.get(card.id)
    if (card.done && !pending) {
      // Begin the grace countdown.
      setGraceIds(prev => new Set(prev).add(card.id))
      const t = setTimeout(() => {
        timersRef.current.delete(card.id)
        setGraceIds(prev => { const n = new Set(prev); n.delete(card.id); return n })
        if (card.recur_interval_minutes == null) {
          // One-time task: remove it so the widget never fills with done items.
          onCardDeleted(card.id)
          deleteCard(card.id, boardId).catch(err => console.error('Failed to delete card:', err))
        }
        // Recurring: it stays done and falls out of the widget filter until the
        // recurrence flips it back to undone.
      }, WIDGET_GRACE_MS)
      timersRef.current.set(card.id, t)
    } else if (!card.done && pending) {
      // Unchecked within the grace window — cancel removal.
      clearTimeout(pending)
      timersRef.current.delete(card.id)
      setGraceIds(prev => { const n = new Set(prev); n.delete(card.id); return n })
    }
  }

  // In a widget list, show only undone cards (plus any in their grace window).
  const visibleCards = isWidget ? cards.filter(c => !c.done || graceIds.has(c.id)) : cards

  const expired = isExpired(list.deadline)
  const label = deadlineLabel(list.deadline)

  const { setNodeRef, isOver } = useDroppable({ id: list.id })

  async function handleAddCard() {
    if (!newCardTitle.trim()) return
    const card = await createCard(list.id, newCardTitle.trim(), boardId)
    onCardAdded(card)
    setNewCardTitle('')
    setAddingCard(false)
  }

  async function handleRename() {
    if (titleValue.trim() && titleValue !== list.name) {
      await renameList(list.id, titleValue.trim(), boardId)
      onListRenamed(list.id, titleValue.trim())
    }
    setEditingTitle(false)
  }

  async function handleDelete() {
    await deleteList(list.id, boardId)
    onListDeleted(list.id)
  }

  async function handleToggleWidget() {
    const next = !isWidget
    setIsWidget(next)
    setShowMenu(false)
    await setListWidget(list.id, next, boardId)
  }

  async function handleSetDeadline() {
    const iso = deadlineValue ? new Date(deadlineValue).toISOString() : null
    await setListDeadline(list.id, iso, boardId)
    setShowExpiryPicker(false)
    setShowMenu(false)
  }

  async function handleClearDeadline() {
    setDeadlineValue('')
    await setListDeadline(list.id, null, boardId)
    setShowExpiryPicker(false)
    setShowMenu(false)
  }

  return (
    <div id={`list-${list.id}`} className="shrink-0 w-72 flex flex-col max-h-full">
      <div
        className={`bg-[#ebecf0] rounded-xl flex flex-col max-h-full shadow transition-shadow
          ${isOver ? 'ring-2 ring-blue-400' : ''}
          ${expired ? 'ring-2 ring-red-400' : ''}`}
      >
        {/* List header */}
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          {editingTitle ? (
            <input
              autoFocus
              value={titleValue}
              onChange={e => setTitleValue(e.target.value)}
              onBlur={handleRename}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') { setTitleValue(list.name); setEditingTitle(false) }
              }}
              className="flex-1 text-sm font-semibold text-gray-800 bg-white border border-blue-500 rounded px-2 py-0.5 focus:outline-none"
            />
          ) : (
            <h3
              className="flex-1 text-sm font-semibold text-gray-800 cursor-pointer px-1 py-0.5 rounded hover:bg-black/5 flex items-center gap-1.5"
              onClick={() => setEditingTitle(true)}
            >
              {list.name}
              {isWidget && <Smartphone size={12} className="text-blue-500 shrink-0" />}
            </h3>
          )}

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => { setShowMenu(!showMenu); setShowExpiryPicker(false) }}
              className="p-1 rounded hover:bg-black/10 text-gray-500"
            >
              <MoreHorizontal size={16} />
            </button>

            {showMenu && (
              <div className="absolute right-0 top-7 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-48 z-20">
                <button
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                  onClick={() => { setEditingTitle(true); setShowMenu(false) }}
                >
                  Rename list
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                  onClick={handleToggleWidget}
                >
                  <Smartphone size={13} className={isWidget ? 'text-blue-500' : 'text-gray-400'} />
                  {isWidget ? 'Remove from widgets' : 'Add as widget'}
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                  onClick={() => setShowExpiryPicker(!showExpiryPicker)}
                >
                  <Clock size={13} className="text-gray-400" />
                  Set expiry
                </button>

                {showExpiryPicker && (
                  <div className="px-3 pb-2 pt-1 border-t border-gray-100">
                    <input
                      type="date"
                      value={deadlineValue}
                      onChange={e => setDeadlineValue(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs mb-1.5 focus:outline-none focus:border-blue-500"
                    />
                    <div className="flex gap-1">
                      <button onClick={handleSetDeadline} className="flex-1 bg-[#0079bf] text-white text-xs py-1 rounded">Set</button>
                      {list.deadline && (
                        <button onClick={handleClearDeadline} className="flex-1 text-xs text-gray-500 border border-gray-200 py-1 rounded hover:bg-gray-50">Clear</button>
                      )}
                    </div>
                  </div>
                )}

                <button
                  className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-gray-100"
                  onClick={() => { handleDelete(); setShowMenu(false) }}
                >
                  Delete this list
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Expiry badge */}
        {label && (
          <div className={`mx-3 mb-1 flex items-center gap-1 text-[10px] font-medium ${expired ? 'text-red-500' : 'text-amber-600'}`}>
            <Clock size={10} />
            {label}
          </div>
        )}

        {/* Cards */}
        <div
          ref={setNodeRef}
          className="flex-1 overflow-y-auto px-2 pb-1 space-y-2 min-h-[8px]"
        >
          <SortableContext items={visibleCards.map(c => c.id)} strategy={verticalListSortingStrategy}>
            {visibleCards.map(card => (
              <CardItem
                key={card.id}
                card={card}
                boardId={boardId}
                isWidget={isWidget}
                onDeleted={onCardDeleted}
                onUpdated={handleCardUpdated}
              />
            ))}
          </SortableContext>
        </div>

        {/* Add card */}
        <div className="px-2 pb-2">
          {addingCard ? (
            <div>
              <textarea
                autoFocus
                rows={2}
                value={newCardTitle}
                onChange={e => setNewCardTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddCard() }
                  if (e.key === 'Escape') { setAddingCard(false); setNewCardTitle('') }
                }}
                placeholder="Enter a title for this card…"
                className="w-full border border-blue-500 rounded px-2 py-1.5 text-sm focus:outline-none resize-none shadow"
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button onClick={handleAddCard} className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm px-3 py-1.5 rounded">Add card</button>
                <button onClick={() => { setAddingCard(false); setNewCardTitle('') }} className="text-gray-500 hover:text-gray-700 p-1"><X size={18} /></button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAddingCard(true)}
              className="w-full flex items-center gap-1.5 text-gray-500 hover:text-gray-800 hover:bg-black/5 rounded px-2 py-1.5 text-sm transition-colors"
            >
              <Plus size={16} />
              Add a card
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
