'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import Link from 'next/link'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, LayoutGrid, ChevronDown, FolderPlus, Check, Trash2, X, CircleUserRound, Settings2, User, Star, Briefcase, Heart, Zap, Globe, Music, Bookmark } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard, createGroup, moveTab, moveBoardToParent, updateBoard, deleteBoard, createPersona } from '@/app/actions'
import { getPersonaId, listPersonas } from '@/lib/persona'
import { BOARD_TAB_MIME, FLOAT_BOARD_MIME } from '@/lib/files'
import NewBoardModal from './NewBoardModal'
import BoardPropertiesPanel from './BoardPropertiesPanel'

const GROUP_COLORS = ['#0079bf', '#d29034', '#519839', '#b04632', '#89609e', '#cd5a91', '#4bbf6b', '#00aecc', '#344563', '#f2d600']

function isExpired(board: Board) {
  return !!board.deadline && new Date(board.deadline) < new Date()
}

const byPos = (a: Board, b: Board) => a.tab_position - b.tab_position || a.created_at.localeCompare(b.created_at)

type OpenPanel = { boardId: string; rect: DOMRect } | null
type GroupMenu = { groupId: string; rect: DOMRect } | null

export default function TabBar({ boards: initialBoards, isAdmin = false }: { boards: Board[]; isAdmin?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const [boards, setBoards] = useState(initialBoards)
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [groupMenu, setGroupMenu] = useState<GroupMenu>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Board | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showPersonas, setShowPersonas] = useState(false)
  const [rememberedPersona, setRememberedPersona] = useState<string | null>(null)
  const [expandedPersonaId, setExpandedPersonaId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [savingPersona, setSavingPersona] = useState(false)
  const draggingRef = useRef<string | null>(null)

  const PERSONA_COLORS = ['#6366f1', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#64748b']
  // TODO: Replace placeholder icons with a real icon picker once asset library is ready
  const PLACEHOLDER_ICONS = [User, Star, Briefcase, Heart, Zap, Globe, Music, Bookmark]

  useEffect(() => { setBoards(initialBoards) }, [initialBoards])
  useEffect(() => { try { setRememberedPersona(localStorage.getItem('activePersonaId')) } catch {} }, [])

  // Drop a remembered persona id once it no longer exists (e.g. deleted), so we
  // never silently fall back to the wrong workspace.
  useEffect(() => {
    if (rememberedPersona && boards.length && !boards.some(b => b.is_persona && b.id === rememberedPersona)) {
      setRememberedPersona(null)
      try { localStorage.removeItem('activePersonaId') } catch {}
    }
  }, [boards, rememberedPersona])

  // ── Active persona ──
  // Structural source of truth: walk the current board up to its persona. On the
  // /boards screen (no board context) fall back to the remembered persona, then
  // the first persona. Null = legacy pre-migration data → behave as before.
  const currentBoardId = pathname.match(/\/board\/([^/]+)/)?.[1] ?? null
  const personas = listPersonas(boards)
  const derivedPersonaId = getPersonaId(currentBoardId, boards)
  const activePersonaId =
    derivedPersonaId ??
    (rememberedPersona && personas.some(p => p.id === rememberedPersona) ? rememberedPersona : null) ??
    personas[0]?.id ?? null
  const activePersona = personas.find(p => p.id === activePersonaId) ?? null

  // Remember the persona whenever we're actually inside one.
  useEffect(() => {
    if (derivedPersonaId) {
      try { localStorage.setItem('activePersonaId', derivedPersonaId) } catch {}
      setRememberedPersona(derivedPersonaId)
    }
  }, [derivedPersonaId])

  // Prefetch the active persona's top tabs so clicking any is instant.
  useEffect(() => {
    initialBoards.forEach(b => {
      if (!b.is_persona && b.parent_id === activePersonaId) router.prefetch(`/board/${b.id}`)
    })
  }, [initialBoards, router, activePersonaId])

  // A membership only counts if its group still exists and is actually a group.
  // Otherwise the tab falls back to the top level — never orphaned/invisible.
  // "Top level" now means a direct child of the active persona (personas excluded).
  const groupIds = new Set(boards.filter(b => b.is_group).map(b => b.id))
  const effectiveGroup = (b: Board) => (b.group_id && groupIds.has(b.group_id) ? b.group_id : null)
  const isTopLevel = (b: Board) => !b.is_persona && b.parent_id === activePersonaId
  const topItems = boards.filter(b => isTopLevel(b) && !effectiveGroup(b)).sort(byPos)
  const membersOf = (gid: string) => boards.filter(b => isTopLevel(b) && effectiveGroup(b) === gid).sort(byPos)

  function openPersonaEdit(p: Board) {
    setExpandedPersonaId(p.id)
    setEditName(p.name)
    setEditColor(p.color)
  }

  async function savePersonaEdit(p: Board) {
    setSavingPersona(true)
    try {
      const name = editName.trim() || p.name
      await updateBoard(p.id, { name, color: editColor })
      setBoards(prev => prev.map(b => b.id === p.id ? { ...b, name, color: editColor } : b))
      setExpandedPersonaId(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not update persona.')
    } finally {
      setSavingPersona(false)
    }
  }

  function switchPersona(p: Board) {
    setShowPersonas(false)
    try { localStorage.setItem('activePersonaId', p.id) } catch {}
    setRememberedPersona(p.id)
    // Never navigate to a persona id directly — land on its first tab, or the
    // boards overview if the persona is empty.
    const firstChild = boards.filter(b => b.parent_id === p.id && !b.is_persona).sort(byPos)[0]
    router.push(firstChild ? `/board/${firstChild.id}` : '/boards')
  }

  async function handleCreatePersona() {
    setShowPersonas(false)
    try {
      const { persona, board } = await createPersona()
      setBoards(prev => [...prev, persona as Board, board as Board])
      try { localStorage.setItem('activePersonaId', persona.id) } catch {}
      setRememberedPersona(persona.id)
      router.push(`/board/${board.id}`)
      router.refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not create persona.')
    }
  }

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
    e.dataTransfer.setData(FLOAT_BOARD_MIME, id)
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

  function doMove(id: string | null, groupId: string | null, beforeId: string | null) {
    endDrag()
    if (!id || id === groupId) return

    // Optimistic reorder — update local state immediately so the UI is instant.
    setBoards(prev => {
      const next = [...prev]
      const from = next.findIndex(b => b.id === id)
      if (from === -1) return prev
      const [moved] = next.splice(from, 1)
      const updated = { ...moved, group_id: groupId ?? null, parent_id: activePersonaId }
      if (beforeId) {
        const to = next.findIndex(b => b.id === beforeId)
        next.splice(to >= 0 ? to : next.length, 0, updated)
      } else {
        next.push(updated)
      }
      // Reassign tab_positions so byPos sorts correctly
      return next.map((b, i) => ({ ...b, tab_position: i }))
    })

    // Persist in background; only refresh on error
    moveTab(id, groupId, beforeId, activePersonaId)
      .then(() => router.refresh())
      .catch(err => { alert(err instanceof Error ? err.message : 'Could not move that tab.'); router.refresh() })
  }

  async function handleDeleteConfirmed() {
    if (!pendingDelete) return
    setDeleting(true)
    const wasActive = pathname === `/board/${pendingDelete.id}`
    setBoards(prev => prev.filter(b => b.id !== pendingDelete.id && b.parent_id !== pendingDelete.id))
    setPendingDelete(null)
    setDeleting(false)
    try {
      await deleteBoard(pendingDelete.id)
    } catch {}
    if (wasActive) router.push('/boards'); else router.refresh()
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
          // Centre 20 % → will become a sub-tab; edges → reorder
          setDragOverId(xRatio >= 0.4 && xRatio <= 0.6 ? `${board.id}:sub` : board.id)
        }}
        onDragLeave={() => setDragOverId(prev => (prev === board.id || prev === `${board.id}:sub`) ? null : prev)}
        onDrop={e => {
          e.preventDefault(); e.stopPropagation()
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const xRatio = (e.clientX - rect.left) / rect.width
          const draggedId = draggingRef.current ?? e.dataTransfer.getData(BOARD_TAB_MIME)
          if (draggedId && draggedId !== board.id && xRatio >= 0.4 && xRatio <= 0.6) {
            endDrag()
            handleMakeSubtab(draggedId, board.id)
          } else {
            doMove(draggedId ?? null, board.group_id ?? null, board.id)
          }
        }}
        className={`relative group/tab shrink-0 transition-colors rounded
          ${dragOverId === board.id ? 'border-l-2 border-[#579dff]' : 'border-l-2 border-transparent'}
          ${dragOverId === `${board.id}:sub` ? 'bg-[#579dff]/20 ring-1 ring-[#579dff]' : isActive ? 'bg-white/10' : 'hover:bg-white/5'}
          ${draggingId === board.id ? 'opacity-40' : ''}`}
      >
        <Link
          href={`/board/${board.id}`}
          className={`flex items-center ${inGroup ? 'pr-6 py-0.5 text-xs' : 'pr-7 py-0.5 text-sm'} whitespace-nowrap border-t-2 transition-colors select-none ${
            isActive ? 'text-white border-[#579dff]'
            : expired ? 'text-red-400/70 border-red-500/40 hover:text-red-300'
            : 'text-white/50 border-transparent hover:text-white/80'
          }`}
        >
          <span className={`flex items-center gap-2 ${inGroup ? 'px-2.5 py-1' : 'px-4 py-2'}`}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: board.color }} />
            {board.name}
            {expired && <span className="text-[10px] text-red-400 ml-1">Expired</span>}
          </span>
        </Link>
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 flex items-center gap-0.5 transition-opacity">
          <button
            onClick={e => { e.preventDefault(); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setGroupMenu(null); setOpenPanel(openPanel?.boardId === board.id ? null : { boardId: board.id, rect }) }}
            className="p-0.5 rounded hover:bg-white/20 text-white/50 hover:text-white"
            title="Edit board"
          >
            <ChevronDown size={11} />
          </button>
          <button
            onClick={e => { e.preventDefault(); e.stopPropagation(); setPendingDelete(board) }}
            className="p-0.5 rounded hover:bg-red-500/70 text-white/40 hover:text-white"
            title="Delete tab"
          >
            <X size={11} />
          </button>
        </div>
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
        onDrop={e => { e.preventDefault(); e.stopPropagation(); doMove(draggingRef.current ?? e.dataTransfer.getData(BOARD_TAB_MIME), group.id, null) }}
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
      <div className="flex items-stretch bg-[#1d2125] border-b border-white/10 shrink-0">
      <div
        className="flex items-stretch overflow-x-auto flex-1 px-1"
        onDragOver={e => { if (draggingRef.current || e.dataTransfer.types.includes(BOARD_TAB_MIME)) { e.preventDefault(); setDragOverId('__strip__') } }}
        onDrop={e => { e.preventDefault(); doMove(draggingRef.current ?? e.dataTransfer.getData(BOARD_TAB_MIME), null, null) }}
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
          onClick={async () => { const g = await createGroup('New group', GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)], 'folder', null, activePersonaId); setBoards(prev => [...prev, g]); router.refresh() }}
          className="flex items-center gap-1.5 px-2 py-2.5 text-white/40 hover:text-white/70 text-sm whitespace-nowrap border-t-2 border-transparent shrink-0"
          title="New group"
        >
          <FolderPlus size={14} />
        </button>
      </div>

        {/* Persona switcher — Google-style account avatar pinned top-right */}
        <div className="relative shrink-0 flex items-center px-2 border-l border-white/10">
          <button
            onClick={() => setShowPersonas(v => !v)}
            className="rounded-full transition focus:outline-none focus:ring-2 focus:ring-white/30"
            title={activePersona ? `Persona: ${activePersona.name}` : 'Personas'}
            aria-label="Switch persona"
          >
            <span
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-semibold ring-1 ring-white/20 hover:ring-white/50 transition"
              style={{ backgroundColor: activePersona?.color ?? '#6366f1' }}
            >
              {activePersona ? activePersona.name.charAt(0).toUpperCase() : <CircleUserRound size={18} />}
            </span>
          </button>
          {showPersonas && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => { setShowPersonas(false); setExpandedPersonaId(null) }} />
              <div className="absolute right-1 top-full mt-1 z-40 w-64 bg-[#282e33] border border-white/10 rounded-lg shadow-xl py-1">
                <p className="px-3 py-1 text-[10px] uppercase tracking-wider text-white/30">Personas</p>
                {personas.length === 0 && (
                  <p className="px-3 py-1.5 text-xs text-white/40">No personas yet</p>
                )}
                {personas.map(p => (
                  <div key={p.id}>
                    <div className="group/prow flex items-center gap-1 px-3 py-1.5 hover:bg-white/5">
                      <button
                        onClick={() => switchPersona(p)}
                        className="flex items-center gap-2 flex-1 min-w-0 text-sm text-left text-white/70 hover:text-white"
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                        <span className="truncate flex-1">{p.name}</span>
                        {p.id === activePersonaId && <Check size={14} className="text-[#579dff] shrink-0" />}
                      </button>
                      <button
                        onClick={() => expandedPersonaId === p.id ? setExpandedPersonaId(null) : openPersonaEdit(p)}
                        title="Persona settings"
                        className="shrink-0 p-1 rounded text-white/25 hover:text-white/70 hover:bg-white/10 opacity-0 group-hover/prow:opacity-100 transition-opacity"
                      >
                        <Settings2 size={12} />
                      </button>
                    </div>

                    {expandedPersonaId === p.id && (
                      <div className="mx-2 mb-2 p-3 bg-white/5 rounded-lg border border-white/10">
                        {/* Name */}
                        <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1">Name</label>
                        <input
                          autoFocus
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') savePersonaEdit(p) }}
                          className="w-full bg-white/10 border border-white/20 rounded px-2 py-1 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/40 mb-3"
                        />

                        {/* Color */}
                        <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-1.5">Color</label>
                        <div className="grid grid-cols-5 gap-1.5 mb-3">
                          {PERSONA_COLORS.map(c => (
                            <button
                              key={c}
                              onClick={() => setEditColor(c)}
                              className="h-5 rounded-full relative"
                              style={{ backgroundColor: c }}
                            >
                              {editColor === c && <Check size={10} className="absolute inset-0 m-auto text-white drop-shadow" />}
                            </button>
                          ))}
                        </div>

                        {/* Icon — placeholder grid, replace with real picker later */}
                        <label className="block text-[10px] text-white/40 uppercase tracking-wider mb-0.5">Icon</label>
                        <p className="text-[10px] text-white/25 mb-1.5">Coming soon — placeholders only</p>
                        {/* TODO: swap PLACEHOLDER_ICONS for a real asset/emoji icon library */}
                        <div className="grid grid-cols-4 gap-1.5 mb-3">
                          {PLACEHOLDER_ICONS.map((Icon, i) => (
                            <button
                              key={i}
                              className="h-8 rounded-lg bg-white/8 flex items-center justify-center hover:bg-white/15 border border-dashed border-white/15 transition-colors"
                              title="Placeholder — icon picker coming soon"
                            >
                              <Icon size={14} className="text-white/40" />
                            </button>
                          ))}
                        </div>

                        {/* Future settings stub */}
                        <div className="border-t border-white/10 pt-2 mb-2.5">
                          <p className="text-[10px] text-white/20 italic">More settings coming soon…</p>
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => setExpandedPersonaId(null)}
                            className="flex-1 py-1 text-xs rounded border border-white/20 text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => savePersonaEdit(p)}
                            disabled={savingPersona}
                            className="flex-1 py-1 text-xs rounded bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-50 transition-colors"
                          >
                            {savingPersona ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <div className="border-t border-white/10 my-1" />
                <button
                  onClick={handleCreatePersona}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-white/60 hover:bg-white/10 hover:text-white"
                >
                  <Plus size={14} /> New persona
                </button>
              </div>
            </>
          )}
        </div>
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
              if (board.is_persona) return
              setOpenPanel(null)
              setPendingDelete(board)
            }}
            isAdmin={isAdmin}
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
            const board = await createBoard(name, color, mode, activePersonaId)
            setBoards(prev => [...prev, board])
            setShowNewBoard(false)
            router.push(`/board/${board.id}`)
          }}
        />
      )}

      {pendingDelete && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => !deleting && setPendingDelete(null)}>
          <div
            className="bg-white rounded-xl shadow-2xl border border-gray-200 p-5 w-80 mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="shrink-0 w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
                <Trash2 size={15} className="text-red-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">Delete &ldquo;{pendingDelete.name}&rdquo;?</p>
                <p className="text-xs text-gray-500 mt-1">This will permanently delete this tab, all its sub-tabs, and every unit inside them. This cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="flex-1 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirmed}
                disabled={deleting}
                className="flex-1 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>,
        document.body
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
