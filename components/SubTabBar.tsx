'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, ChevronDown } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createSubTab, deleteBoard } from '@/app/actions'
import BoardPropertiesPanel from './BoardPropertiesPanel'

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

type OpenPanel = { boardId: string; rect: DOMRect } | null

export default function SubTabBar({ allBoards }: { allBoards: Board[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)

  const boardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  if (!boardId) return null

  const currentBoard = allBoards.find(b => b.id === boardId)
  if (!currentBoard) return null

  const isSubTab = !!currentBoard.parent_id
  const hasChildren = allBoards.some(b => b.parent_id === boardId)

  if (!isSubTab && !hasChildren) return null

  const chain = getAncestorChain(allBoards, boardId)

  const rows: Array<{ parentId: string; tabs: Board[]; selectedId: string; depth: number }> = []

  for (let i = 0; i < chain.length; i++) {
    const board = chain[i]
    if (!board.parent_id) continue
    const siblings = allBoards
      .filter(b => b.parent_id === board.parent_id)
      .sort((a, b) => a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at))
    rows.push({ parentId: board.parent_id, tabs: siblings, selectedId: board.id, depth: i })
  }

  if (hasChildren) {
    const childTabs = allBoards
      .filter(b => b.parent_id === boardId)
      .sort((a, b) => a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at))
    rows.push({ parentId: boardId, tabs: childTabs, selectedId: '', depth: chain.length })
  }

  if (rows.length === 0) return null

  async function handleCreate(parentId: string) {
    if (creating) return
    setCreating(true)
    try {
      const parent = allBoards.find(b => b.id === parentId)
      const count = allBoards.filter(b => b.parent_id === parentId).length
      const sub = await createSubTab(parentId, `Tab ${count + 1}`, parent?.color ?? '#0079bf')
      router.push(`/board/${sub.id}`)
      router.refresh()
    } finally {
      setCreating(false)
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
              <div key={tab.id} className="relative group/tab shrink-0">
                <button
                  onClick={() => router.push(`/board/${tab.id}`)}
                  className={`flex items-center gap-1.5 px-2.5 pr-6 py-1 text-xs whitespace-nowrap border-b-2 transition-colors mr-0.5 rounded-t ${
                    isCurrent ? 'text-white border-[#579dff] bg-white/10'
                    : isSelected ? 'text-white/60 border-white/20 bg-white/5'
                    : 'text-white/40 border-transparent hover:text-white/70 hover:bg-white/5'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tab.color }} />
                  {tab.name}
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    setOpenPanel(openPanel?.boardId === tab.id ? null : { boardId: tab.id, rect })
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 p-0.5 rounded hover:bg-white/20 text-white/40 hover:text-white transition-opacity"
                  title="Edit sub-tab"
                >
                  <ChevronDown size={10} />
                </button>
              </div>
            )
          })}

          <button
            onClick={() => handleCreate(parentId)}
            disabled={creating}
            className="text-white/25 hover:text-white/60 p-1 rounded ml-0.5 shrink-0 disabled:opacity-40"
            title="Add sub-tab"
          >
            <Plus size={10} />
          </button>
        </div>
      ))}

      {/* Add first child to current board when no children row exists */}
      {isSubTab && !hasChildren && (
        <div className="flex items-center px-3 py-0.5 border-t border-white/5">
          <button
            onClick={() => handleCreate(boardId)}
            disabled={creating}
            className="text-[10px] text-white/20 hover:text-white/50 flex items-center gap-0.5 py-0.5 disabled:opacity-40"
          >
            <Plus size={9} /> {creating ? 'Creating…' : 'Add sub-tab'}
          </button>
        </div>
      )}

      {openPanel && (() => {
        const board = allBoards.find(b => b.id === openPanel.boardId)
        if (!board) return null
        return (
          <BoardPropertiesPanel
            board={board}
            anchorRect={openPanel.rect}
            onClose={() => setOpenPanel(null)}
            onUpdate={() => { setOpenPanel(null); router.refresh() }}
            onRemove={() => {
              if (!confirm(`Remove "${board.name}" and everything in it?`)) return
              const wasActive = pathname === `/board/${board.id}`
              setOpenPanel(null)
              deleteBoard(board.id).catch(() => {})
              if (wasActive) router.push(board.parent_id ? `/board/${board.parent_id}` : '/boards')
              else router.refresh()
            }}
          />
        )
      })()}
    </div>
  )
}
