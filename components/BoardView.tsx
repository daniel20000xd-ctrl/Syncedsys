'use client'

import { useState, useTransition, useCallback } from 'react'
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { Board, List, Card } from '@/lib/types'
import { createList, reorderCards } from '@/app/actions'
import KanbanList from './KanbanList'
import CardItem from './CardItem'
import { Plus } from 'lucide-react'

export default function BoardView({
  board,
  initialLists,
  initialCards,
}: {
  board: Board
  initialLists: List[]
  initialCards: Card[]
}) {
  const [lists, setLists] = useState<List[]>(initialLists)
  const [cards, setCards] = useState<Card[]>(initialCards)
  const [activeCard, setActiveCard] = useState<Card | null>(null)
  const [addingList, setAddingList] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [isPending, startTransition] = useTransition()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  function onDragStart(event: DragStartEvent) {
    const card = cards.find(c => c.id === event.active.id)
    if (card) setActiveCard(card)
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const activeCard = cards.find(c => c.id === active.id)
    if (!activeCard) return

    // over a list directly (empty list)
    const overList = lists.find(l => l.id === over.id)
    if (overList && activeCard.list_id !== overList.id) {
      setCards(prev =>
        prev.map(c =>
          c.id === activeCard.id ? { ...c, list_id: overList.id, position: 0 } : c
        )
      )
      return
    }

    // over another card
    const overCard = cards.find(c => c.id === over.id)
    if (!overCard) return

    if (activeCard.list_id !== overCard.list_id) {
      // move to new list
      setCards(prev => {
        const withoutActive = prev.filter(c => c.id !== activeCard.id)
        const targetListCards = withoutActive
          .filter(c => c.list_id === overCard.list_id)
          .sort((a, b) => a.position - b.position)
        const overIdx = targetListCards.findIndex(c => c.id === overCard.id)
        const inserted = [
          ...targetListCards.slice(0, overIdx + 1),
          { ...activeCard, list_id: overCard.list_id },
          ...targetListCards.slice(overIdx + 1),
        ].map((c, i) => ({ ...c, position: i }))

        return [
          ...withoutActive.filter(c => c.list_id !== overCard.list_id),
          ...inserted,
        ]
      })
    } else {
      // same list reorder
      setCards(prev => {
        const listCards = prev
          .filter(c => c.list_id === activeCard.list_id)
          .sort((a, b) => a.position - b.position)
        const oldIdx = listCards.findIndex(c => c.id === activeCard.id)
        const newIdx = listCards.findIndex(c => c.id === overCard.id)
        const reordered = arrayMove(listCards, oldIdx, newIdx).map((c, i) => ({
          ...c,
          position: i,
        }))
        return [...prev.filter(c => c.list_id !== activeCard.list_id), ...reordered]
      })
    }
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveCard(null)
    // Persist new order
    const updates = cards.map(c => ({ id: c.id, list_id: c.list_id, position: c.position }))
    startTransition(() => reorderCards(updates, board.id))
  }

  async function handleAddList() {
    if (!newListName.trim()) return
    const created = await createList(board.id, newListName.trim())
    setLists(prev => [...prev, created])
    setCards(prev => prev)
    setNewListName('')
    setAddingList(false)
  }

  function updateCardLocal(updated: Card) {
    setCards(prev => prev.map(c => c.id === updated.id ? updated : c))
  }

  function deleteCardLocal(cardId: string) {
    setCards(prev => prev.filter(c => c.id !== cardId))
  }

  function addCardLocal(card: Card) {
    setCards(prev => [...prev, card])
  }

  function deleteListLocal(listId: string) {
    setLists(prev => prev.filter(l => l.id !== listId))
    setCards(prev => prev.filter(c => c.list_id !== listId))
  }

  function renameListLocal(listId: string, name: string) {
    setLists(prev => prev.map(l => l.id === listId ? { ...l, name } : l))
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ backgroundColor: board.color }}
    >
      {/* Board title */}
      <div className="px-4 pt-3 pb-1 bg-black/10">
        <h1 className="text-white font-bold text-lg">{board.name}</h1>
      </div>

      {/* Lists */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
        >
          <div className="flex gap-3 p-4 h-full items-start">
            {lists.map(list => (
              <KanbanList
                key={list.id}
                list={list}
                cards={cards.filter(c => c.list_id === list.id).sort((a, b) => a.position - b.position)}
                boardId={board.id}
                onCardAdded={addCardLocal}
                onCardDeleted={deleteCardLocal}
                onCardUpdated={updateCardLocal}
                onListDeleted={deleteListLocal}
                onListRenamed={renameListLocal}
              />
            ))}

            {/* Add list */}
            <div className="shrink-0 w-72">
              {addingList ? (
                <div className="bg-[#ebecf0] rounded-xl p-2 shadow">
                  <input
                    autoFocus
                    value={newListName}
                    onChange={e => setNewListName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleAddList()
                      if (e.key === 'Escape') { setAddingList(false); setNewListName('') }
                    }}
                    placeholder="Enter list name…"
                    className="w-full border border-blue-500 rounded px-2 py-1.5 text-sm focus:outline-none mb-2"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddList}
                      className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm px-3 py-1.5 rounded"
                    >
                      Add list
                    </button>
                    <button
                      onClick={() => { setAddingList(false); setNewListName('') }}
                      className="text-gray-500 hover:text-gray-700 text-sm px-2 py-1.5"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAddingList(true)}
                  className="w-full flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white rounded-xl px-3 py-2.5 text-sm font-medium transition-colors"
                >
                  <Plus size={16} />
                  Add a list
                </button>
              )}
            </div>
          </div>

          <DragOverlay>
            {activeCard && (
              <div className="bg-white rounded-lg shadow-xl p-2 text-sm text-gray-800 w-72 rotate-2 opacity-90">
                {activeCard.title}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  )
}
