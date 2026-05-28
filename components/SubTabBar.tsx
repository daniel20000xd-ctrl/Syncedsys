'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createSubTab } from '@/app/actions'

function getAncestorChain(allBoards: Board[], boardId: string): Board[] {
  const chain: Board[] = []
  let currentId: string | null = boardId
  while (currentId) {
    const board = allBoards.find(b => b.id === currentId)
    if (!board) break
    chain.unshift(board)
    currentId = board.parent_id ?? null
  }
  return chain
}

export default function SubTabBar({ allBoards }: { allBoards: Board[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const boardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  if (!boardId) return null

  const currentBoard = allBoards.find(b => b.id === boardId)
  if (!currentBoard) return null

  const isSubTab = !!currentBoard.parent_id
  const hasChildren = allBoards.some(b => b.parent_id === boardId)

  if (!isSubTab && !hasChildren) return null

  const chain = getAncestorChain(allBoards, boardId)

  // One row per sub-tab level in the chain, showing that board's siblings
  const rows: Array<{
    parentId: string
    tabs: Board[]
    selectedId: string
    depth: number
  }> = []

  for (let i = 0; i < chain.length; i++) {
    const board = chain[i]
    if (!board.parent_id) continue  // root boards live in the main TabBar

    const siblings = allBoards
      .filter(b => b.parent_id === board.parent_id)
      .sort((a, b) => a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at))

    rows.push({ parentId: board.parent_id, tabs: siblings, selectedId: board.id, depth: i })
  }

  // Row for current board's children (if any exist)
  if (hasChildren) {
    const childTabs = allBoards
      .filter(b => b.parent_id === boardId)
      .sort((a, b) => a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at))
    rows.push({ parentId: boardId, tabs: childTabs, selectedId: '', depth: chain.length })
  }

  if (rows.length === 0) return null

  async function handleCreate(parentId: string) {
    if (!newName.trim() || creating) return
    setCreating(true)
    try {
      const parent = allBoards.find(b => b.id === parentId)
      const sub = await createSubTab(parentId, newName.trim(), parent?.color ?? '#0079bf')
      router.push(`/board/${sub.id}`)
      router.refresh()
    } finally {
      setCreating(false)
      setNewName('')
      setAddingTo(null)
    }
  }

  return (
    <div className="bg-[#161a1d] border-b border-white/10 shrink-0">
      {rows.map(({ parentId, tabs, selectedId }, rowIndex) => (
        <div
          key={parentId}
          className="flex items-center overflow-x-auto border-b border-white/5 last:border-0"
          style={{ paddingLeft: `${6 + rowIndex * 12}px`, paddingRight: '4px', paddingTop: '2px', paddingBottom: '2px' }}
        >
          {tabs.map(tab => {
            const isCurrent = tab.id === boardId
            const isSelected = tab.id === selectedId
            return (
              <button
                key={tab.id}
                onClick={() => router.push(`/board/${tab.id}`)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs whitespace-nowrap border-b-2 transition-colors mr-0.5 rounded-t ${
                  isCurrent
                    ? 'text-white border-[#579dff] bg-white/10'
                    : isSelected
                    ? 'text-white/60 border-white/20 bg-white/5'
                    : 'text-white/40 border-transparent hover:text-white/70 hover:bg-white/5'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tab.color }} />
                {tab.name}
              </button>
            )
          })}

          {addingTo === parentId ? (
            <div className="flex items-center gap-1 ml-1 shrink-0">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate(parentId)
                  if (e.key === 'Escape') { setAddingTo(null); setNewName('') }
                }}
                placeholder="Name…"
                className="bg-white/10 text-white text-xs px-2 py-0.5 rounded border border-white/20 focus:outline-none focus:border-white/40 w-24"
              />
              <button
                onClick={() => handleCreate(parentId)}
                disabled={creating}
                className="text-white/60 hover:text-white text-xs px-1.5 py-0.5 rounded bg-white/10 shrink-0"
              >
                {creating ? '…' : 'Add'}
              </button>
              <button
                onClick={() => { setAddingTo(null); setNewName('') }}
                className="text-white/30 hover:text-white/60 p-0.5 shrink-0"
              >
                <X size={10} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setAddingTo(parentId); setNewName('') }}
              className="text-white/25 hover:text-white/60 p-1 rounded ml-0.5 shrink-0"
              title="Add sub-tab"
            >
              <Plus size={10} />
            </button>
          )}
        </div>
      ))}

      {/* Button to add first child sub-tab to current board (only when no children row exists) */}
      {isSubTab && !hasChildren && (
        <div className="flex items-center px-3 py-0.5 border-t border-white/5">
          {addingTo === boardId ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate(boardId)
                  if (e.key === 'Escape') { setAddingTo(null); setNewName('') }
                }}
                placeholder="Sub-tab name…"
                className="bg-white/10 text-white text-xs px-2 py-0.5 rounded border border-white/20 focus:outline-none focus:border-white/40 w-28"
              />
              <button
                onClick={() => handleCreate(boardId)}
                disabled={creating}
                className="text-white/60 hover:text-white text-xs px-1.5 py-0.5 rounded bg-white/10"
              >
                {creating ? '…' : 'Add'}
              </button>
              <button onClick={() => { setAddingTo(null); setNewName('') }} className="text-white/30 hover:text-white/60 p-0.5">
                <X size={10} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setAddingTo(boardId); setNewName('') }}
              className="text-[10px] text-white/20 hover:text-white/50 flex items-center gap-0.5 py-0.5"
            >
              <Plus size={9} /> Add sub-tab
            </button>
          )}
        </div>
      )}
    </div>
  )
}
