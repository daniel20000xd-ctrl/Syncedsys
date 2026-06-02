'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, LayoutGrid, ChevronDown, FolderPlus, Check, Trash2 } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard, createGroup, moveTab, moveBoardToParent, updateBoard, deleteBoard } from '@/app/actions'
import { BOARD_TAB_MIME } from '@/lib/files'
import NewBoardModal from './NewBoardModal'
import BoardPropertiesPanel from './BoardPropertiesPanel'

const GROUP_COLORS = ['#0079bf', '#d29034', '#519839', '#b04632', '#89609e', '#cd5a91', '#4bbf6b', '#00aecc', '#344563', '#f2d600']

function isExpired(board: Board) {
  return !!board.deadline && new Date(board.deadline) < new Date()
}

const byPos = (a: Board, b: Board) => a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at)

type OpenPanel = { boardId: string; rect: DOMRect } | null
type GroupMenu = { groupId: string; rect: DOMRect } | null

export default function TabBar({ boards: initialBoards }: { boards: Board[] }) {
  const pathname = usePathname()
  const router = useRouter()
  const [boards, setBoards] = useState(initialBoards)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [groupMenu, setGroupMenu] = useState<GroupMenu>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const draggingRef = useRef<string | null>(null)

  useEffect(() => { setBoards(initialBoards) }, [initialBoards])

  // A membership only counts if its group still exists and is actually a group.
  // Otherwise the tab falls back to the top level — never orphaned/invisible.
  const groupIds = new Set(boards.filter(b => b.is_group).map(b => b.id))
  const effectiveGroup = (b: Board) => (b.group_id && groupIds.has(b.group_id) ? b.group_id : null)
  const topItems = boards.filter(b => !b.parent_id && !effectiveGroup(b)).sort(byPos)
  const membersOf = (gid: string) => boards.filter(b => !b.parent_id && effectiveGroup(b) === gid).sort(byPos)

  // Flattened visual order for Alt+Q / Alt+W navigation.
  const flatOrder: Board[] = []
  const pushItem = (b: Board) => { flatOrder.push(b); if (b.is_group) membersOf(b.id).forEach(pushItem) }
  topItems.forEach(pushItem)

  const activeIndex = flatOrder.findIndex(b => pathname === `/board/${b.id}`)
  const goToTab = useCallback((index: number) => {
    if (flatOrder.length === 0) return
    const clamped = (index + flatOrder.length) % flatOrder.length
    router.push(`/board/${flatOrder[clamped].id}`)
  }, [flatOrder, router])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return
      if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); goToTab(activeIndex - 1) }
      if (e.key === 'w' || e.key === 'W') { e.preventDefault(); goToTab(activeIndex + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIndex, goToTab])

  function startDrag(e: React.DragEvent, id: string) {
    draggingRef.current = id
    setDraggingId(id)
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.setData(BOARD_TAB_MIME, id)
    e.dataTransfer.effectAllowed = 'move'
  }
  function endDrag() { draggingRef.current = null; setDraggingId(null); setDragOverId(null) }

  async function handleMakeSubtab(boardId: string, parentId: string) {
    try {
      await moveBoardToParent(boardId, parentId)
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not nest that tab.')
      router.refresh()
    }
  }

  async function doMove(groupId: string | null, beforeId: string | null) {
    const id = draggingRef.current
    endDrag()
    if (!id || id === groupId) return
    try {
      await moveTab(id, groupId, beforeId)
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not move that tab.')
      router.refresh()
    }
  }

  const isAllBoards = pathname === '/boards'

  // ── A single tab (normal board) ──
  function Tab(board: Board, inGroup: boolean) {
    const isActive = pathname === `/board/${board.id}`
    const expired = isExpired(board)
    return (
      <div
        key={board.id}
        draggable
        onMouseEnter={() => router.prefetch(`/board/${board.id}`)}
        onDragStart={e => { e.stopPropagation(); startDrag(e, board.id) }}
        onDragEnd={endDrag}
        onDragOver={e => {
          e.preventDefault(); e.stopPropagation()
          const hasBoard = draggingRef.current || e.dataTransfer.types.includes(BOARD_TAB_MIME)
          if (!hasBoard) return
          const draggedId = draggingRef.current ?? e.dataTransfer.getData(BOARD_TAB_MIME)
          if (draggedId === board.id) return
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const xRatio = (e.clientX - rect.left) / rect.width
          // Centre 40 % → will become a sub-tab; edges → reorder
          setDragOverId(xRatio >= 0.3 && xRatio <= 0.7 ? `${board.id}:sub` : board.id)
        }}
        onDragLeave={() => setDragOverId(prev => (prev === board.id || prev === `${board.id}:sub`) ? null : prev)}
        onDrop={e => {
          e.preventDefault(); e.stopPropagation()
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const xRatio = (e.clientX - rect.left) / rect.width
          const draggedId = draggingRef.current ?? e.dataTransfer.getData(BOARD_TAB_MIME)
          if (draggedId && draggedId !== board.id && xRatio >= 0.3 && xRatio <= 0.7) {
            endDrag()
            handleMakeSubtab(draggedId, board.id)
          } else {
            doMove(board.group_id ?? null, board.id)
          }
        }}
        className={`relative group/tab shrink-0 transition-colors
          ${dragOverId === board.id ? 'border-l-2 border-[#579dff]' : 'border-l-2 border-transparent'}
          ${dragOverId === `${board.id}:sub` ? 'bg-[#579dff]/20 ring-1 ring-[#579dff] rounded' : ''}
          ${draggingId === board.id ? 'opacity-40' : ''}`}
      >
        <Link
          href={`/board/${board.id}`}
          className={`flex items-center gap-2 ${inGroup ? 'px-2.5 py-1 text-xs' : 'px-4 py-2.5 text-sm'} pr-7 whitespace-nowrap border-t-2 transition-colors select-none ${
            isActive ? 'bg-white/10 text-white border-[#579dff]'
            : expired ? 'text-red-400/70 border-red-500/40 hover:text-red-300 hover:bg-white/5'
            : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
          }`}
        >
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: board.color }} />
          {board.name}
          {expired && <span className="text-[10px] text-red-400 ml-1">Expired</span>}
        </Link>
        <button
          onClick={e => { e.preventDefault(); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setGroupMenu(null); setOpenPanel(openPanel?.boardId === board.id ? null : { boardId: board.id, rect }) }}
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 p-1 rounded hover:bg-white/20 text-white/50 hover:text-white transition-opacity"
          title="Edit board"
        >
          <ChevronDown size={12} />
        </button>
      </div>
    )
  }

  // ── A group region (colored line above its member tabs) ──
  function GroupRegion(group: Board) {
    const members = membersOf(group.id)
    return (
      <div
        key={group.id}
        draggable
        onDragStart={e => startDrag(e, group.id)}
        onDragEnd={endDrag}
        onDragOver={e => { e.preventDefault(); if (draggingRef.current && draggingRef.current !== group.id) setDragOverId(group.id) }}
        onDragLeave={() => setDragOverId(prev => prev === group.id ? null : prev)}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); doMove(group.id, null) }}
        className={`shrink-0 flex flex-col mx-0.5 my-1 rounded-md ${dragOverId === group.id ? 'ring-2 ring-offset-0' : ''}`}
        style={{ backgroundColor: `${group.color}1a`, ...(dragOverId === group.id ? { boxShadow: `inset 0 0 0 2px ${group.color}` } : {}) }}
      >
        {/* Coloured line + label */}
        <div className="flex items-center gap-1 px-1.5 pt-0.5" style={{ borderTop: `3px solid ${group.color}` }}>
          <button
            onClick={() => router.push(`/board/${group.id}`)}
            className="flex items-center gap-1 text-[11px] font-semibold text-white/80 hover:text-white px-1 py-0.5 rounded"
            title="Open group"
          >
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: group.color }} />
            {group.name}
            <span className="text-white/30">{group.mode === 'folder' ? '📁' : '🎨'}</span>
          </button>
          <button
            onClick={e => { const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOpenPanel(null); setGroupMenu(groupMenu?.groupId === group.id ? null : { groupId: group.id, rect }) }}
            className="p-0.5 rounded hover:bg-white/20 text-white/40 hover:text-white"
            title="Edit group"
          >
            <ChevronDown size={11} />
          </button>
        </div>
        {/* Members */}
        <div className="flex items-end px-1 pb-0.5 min-h-[28px]">
          {members.length === 0 && <span className="text-[10px] text-white/25 px-2 py-1">drop tabs here</span>}
          {members.map(m => m.is_group ? GroupRegion(m) : Tab(m, true))}
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        className="flex items-stretch bg-[#1d2125] border-b border-white/10 overflow-x-auto shrink-0 px-1"
        onDragOver={e => { if (draggingRef.current) { e.preventDefault(); setDragOverId('__strip__') } }}
        onDrop={e => { e.preventDefault(); doMove(null, null) }}
      >
        <Link
          href="/boards"
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm whitespace-nowrap border-t-2 transition-colors select-none shrink-0 ${
            isAllBoards ? 'bg-white/10 text-white border-[#579dff]' : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
          }`}
        >
          <LayoutGrid size={14} />
          All boards
        </Link>

        {topItems.map(item => item.is_group ? GroupRegion(item) : Tab(item, false))}

        <button
          onClick={() => setShowNewBoard(true)}
          className="flex items-center gap-1.5 px-3 py-2.5 text-white/40 hover:text-white/70 text-sm whitespace-nowrap border-t-2 border-transparent shrink-0"
          title="New board"
        >
          <Plus size={14} />
        </button>
        <button
          onClick={async () => { const g = await createGroup('New group', GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)], 'folder'); setBoards(prev => [...prev, g]); router.refresh() }}
          className="flex items-center gap-1.5 px-2 py-2.5 text-white/40 hover:text-white/70 text-sm whitespace-nowrap border-t-2 border-transparent shrink-0"
          title="New group"
        >
          <FolderPlus size={14} />
        </button>
      </div>

      {openPanel && (() => {
        const board = boards.find(b => b.id === openPanel.boardId)
        if (!board) return null
        return (
          <BoardPropertiesPanel
            board={board}
            anchorRect={openPanel.rect}
            onClose={() => setOpenPanel(null)}
            onUpdate={updated => { setBoards(prev => prev.map(b => b.id === updated.id ? updated : b)); setOpenPanel(null); router.refresh() }}
            onRemove={() => {
              if (!confirm(`Remove "${board.name}" and everything in it?`)) return
              const wasActive = pathname === `/board/${board.id}`
              setBoards(prev => prev.filter(b => b.id !== board.id))
              setOpenPanel(null)
              deleteBoard(board.id).catch(() => {})
              if (wasActive) router.push('/boards'); else router.refresh()
            }}
          />
        )
      })()}

      {groupMenu && (() => {
        const group = boards.find(b => b.id === groupMenu.groupId)
        if (!group) return null
        return (
          <GroupMenuPanel
            group={group}
            anchorRect={groupMenu.rect}
            onClose={() => setGroupMenu(null)}
            onSaved={() => { setGroupMenu(null); router.refresh() }}
            onDeleted={() => {
              setBoards(prev => prev.filter(b => b.id !== group.id))
              setGroupMenu(null)
              deleteBoard(group.id).catch(() => {})
              router.refresh()
            }}
          />
        )
      })()}

      {showNewBoard && (
        <NewBoardModal
          onClose={() => setShowNewBoard(false)}
          onCreate={async (name, color, mode) => {
            const board = await createBoard(name, color, mode)
            setBoards(prev => [...prev, board])
            setShowNewBoard(false)
            router.push(`/board/${board.id}`)
          }}
        />
      )}
    </>
  )
}

// ── Small group editor: name, colour, mode (folder/canvas), delete ──
function GroupMenuPanel({ group, anchorRect, onClose, onSaved, onDeleted }: {
  group: Board; anchorRect: DOMRect; onClose: () => void; onSaved: () => void; onDeleted: () => void
}) {
  const [name, setName] = useState(group.name)
  const [color, setColor] = useState(group.color)
  const [mode, setMode] = useState<'folder' | 'classic'>(group.mode === 'classic' ? 'classic' : 'folder')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    setTimeout(() => document.addEventListener('mousedown', onClick), 0)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  async function save() {
    setSaving(true)
    try { await updateBoard(group.id, { name: name.trim() || group.name, color, mode }); onSaved() }
    finally { setSaving(false) }
  }

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: anchorRect.bottom + 6, left: Math.min(anchorRect.left, window.innerWidth - 232), zIndex: 9999 }}
      className="bg-white rounded-lg shadow-xl border border-gray-200 p-3 w-56"
    >
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Group</p>
      <input
        autoFocus value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save() }}
        className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-2 focus:outline-none focus:border-blue-500"
      />
      <div className="grid grid-cols-5 gap-1.5 mb-2">
        {GROUP_COLORS.map(c => (
          <button key={c} onClick={() => setColor(c)} className="h-6 rounded relative" style={{ backgroundColor: c }}>
            {color === c && <Check size={11} className="absolute inset-0 m-auto text-white drop-shadow" />}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        {(['folder', 'classic'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} className={`py-1.5 rounded text-xs font-medium border ${mode === m ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
            {m === 'folder' ? '📁 Folder' : '🎨 Canvas'}
          </button>
        ))}
      </div>
      <button onClick={save} disabled={saving} className="w-full bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm py-1.5 rounded disabled:opacity-60 mb-2">{saving ? 'Saving…' : 'Save'}</button>
      <button onClick={onDeleted} className="w-full flex items-center justify-center gap-1.5 text-xs text-red-600 hover:bg-red-50 py-1.5 rounded">
        <Trash2 size={12} /> Delete group (keeps tabs)
      </button>
    </div>,
    document.body
  )
}
