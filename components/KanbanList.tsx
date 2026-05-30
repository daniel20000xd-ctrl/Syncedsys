'use client'

import { useState, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { MoreHorizontal, Plus, X, Check, Smartphone } from 'lucide-react'
import type { List, Card } from '@/lib/types'
import { createCard, deleteList, renameList, setListWidget } from '@/app/actions'
import CardItem from './CardItem'

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
  const [isWidget, setIsWidget] = useState(list.is_widget)
  const menuRef = useRef<HTMLDivElement>(null)

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

  return (
    <div id={`list-${list.id}`} className="shrink-0 w-72 flex flex-col max-h-full">
      <div
        className={`bg-[#ebecf0] rounded-xl flex flex-col max-h-full shadow transition-shadow ${isOver ? 'ring-2 ring-blue-400' : ''}`}
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
              onClick={() => setShowMenu(!showMenu)}
              className="p-1 rounded hover:bg-black/10 text-gray-500"
            >
              <MoreHorizontal size={16} />
            </button>
            {showMenu && (
              <div className="absolute right-0 top-7 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-40 z-20">
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
                  className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-gray-100"
                  onClick={() => { handleDelete(); setShowMenu(false) }}
                >
                  Delete this list
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Cards */}
        <div
          ref={setNodeRef}
          className="flex-1 overflow-y-auto px-2 pb-1 space-y-2 min-h-[8px]"
        >
          <SortableContext items={cards.map(c => c.id)} strategy={verticalListSortingStrategy}>
            {cards.map(card => (
              <CardItem
                key={card.id}
                card={card}
                boardId={boardId}
                onDeleted={onCardDeleted}
                onUpdated={onCardUpdated}
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
                <button
                  onClick={handleAddCard}
                  className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm px-3 py-1.5 rounded"
                >
                  Add card
                </button>
                <button
                  onClick={() => { setAddingCard(false); setNewCardTitle('') }}
                  className="text-gray-500 hover:text-gray-700 p-1"
                >
                  <X size={18} />
                </button>
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
