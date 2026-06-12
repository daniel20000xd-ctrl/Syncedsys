'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { Folder, FolderPlus, FileText, FileType, File as FileIcon, ArrowLeft, Trash2, X, Save, Download, ChevronDown, Upload } from 'lucide-react'
import type { Board, BoardElement } from '@/lib/types'
import {
  createSubTab, deleteBoard, createTextFile, updateTextFile, deleteElement,
  moveElementToBoard, importFolderTree, moveBoardToParent, reorderFolderItems,
  createElement, getPdfUrl, getPresignedReadUrl, deleteStorageObjects,
} from '@/app/actions'
import { collectEntries, readDroppedEntries, readPickedFolder, downloadTextFile, type PickedFolder } from '@/lib/files'
import { uploadPdf, uploadFile, extractPdfText, buildUploadTree } from '@/lib/pdf'
import { folderUnitsStore } from '@/lib/folderUnitsStore'
import BoardPropertiesPanel from './BoardPropertiesPanel'
import BoardReadme from './BoardReadme'

const MODE_EMOJI: Record<string, string> = { classic: '🎨', trello: '🗂', text: '📝', folder: '📁' }
const FILE_MIME = 'application/x-syncedsys-fileid'
const FOLDER_MIME = 'application/x-syncedsys-folderid'

type CreateMode = 'folder' | 'classic' | 'trello' | 'text'
const CREATE_OPTIONS: { mode: CreateMode; label: string; emoji: string; name: string }[] = [
  { mode: 'folder', label: 'New folder', emoji: '📁', name: 'New folder' },
  { mode: 'classic', label: 'New canvas', emoji: '🎨', name: 'New canvas' },
  { mode: 'trello', label: 'New board', emoji: '🗂', name: 'New board' },
  { mode: 'text', label: 'New document', emoji: '📝', name: 'New document' },
]

// Where an item will be inserted relative to the hovered tile.
type InsertAt = { id: string; side: 'before' | 'after' } | null

export default function FolderBoardView({
  board,
  initialFolders,
  initialFiles,
}: {
  board: Board
  initialFolders: Board[]
  initialFiles: BoardElement[]
}) {
  const router = useRouter()

  // Both arrays are sorted by their position columns so ordering persists
  // across page reloads.
  const [folders, setFolders] = useState<Board[]>(() =>
    [...initialFolders].sort((a, b) => a.tab_position - b.tab_position)
  )
  // Files store their folder sort order as `folder_position` in the JSON data
  // blob (no schema migration needed). Fall back to created_at so new files
  // inserted before this feature land in a sensible order.
  const [files, setFiles] = useState<BoardElement[]>(() =>
    [...initialFiles].sort((a, b) => {
      const pa = (a.data.folder_position as number | undefined) ?? new Date(a.created_at).getTime()
      const pb = (b.data.folder_position as number | undefined) ?? new Date(b.created_at).getTime()
      return pa - pb
    })
  )

  const [dragOver, setDragOver] = useState(false)
  const [editing, setEditing] = useState<BoardElement | null>(null)
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)  // "nest into" target
  const [insertAt, setInsertAt] = useState<InsertAt>(null)              // reorder target
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const draggingIdRef = useRef<string | null>(null)
  const draggingKindRef = useRef<'folder' | 'file' | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null)
  const [folderPanel, setFolderPanel] = useState<{ boardId: string; rect: DOMRect } | null>(null)
  const [fileMenu, setFileMenu] = useState<{ fileId: string; rect: DOMRect } | null>(null)
  const dragDepth = useRef(0)
  const marqueeStart = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)

  // ── Reorder helpers ──────────────────────────────────────────────────────────

  function spliceItem<T extends { id: string }>(arr: T[], dragId: string, targetId: string, side: 'before' | 'after'): T[] {
    const dragged = arr.find(x => x.id === dragId)
    if (!dragged) return arr
    const without = arr.filter(x => x.id !== dragId)
    const targetIdx = without.findIndex(x => x.id === targetId)
    const insertIdx = targetIdx < 0 ? without.length : side === 'before' ? targetIdx : targetIdx + 1
    const next = [...without]
    next.splice(insertIdx, 0, dragged)
    return next
  }

  function clearDragState() {
    setDraggingId(null)
    draggingIdRef.current = null
    draggingKindRef.current = null
    setMoveTargetId(null)
    setInsertAt(null)
  }

  // Called on dragOver for any tile. Returns true if the event was handled
  // (caller should call e.preventDefault / e.stopPropagation).
  function computeDragIntent(
    e: React.DragEvent,
    tileId: string,
    tileKind: 'folder' | 'file',
  ) {
    const types = e.dataTransfer.types
    const isOsFile = types.includes('Files') && !types.includes(FILE_MIME) && !types.includes(FOLDER_MIME)
    if (isOsFile) return  // OS file drop — handled by container

    const dragKind = types.includes(FOLDER_MIME) ? 'folder' : types.includes(FILE_MIME) ? 'file' : null
    if (!dragKind) return
    if (draggingIdRef.current === tileId) return  // self

    e.preventDefault()
    e.stopPropagation()

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const xRatio = (e.clientX - rect.left) / rect.width
    const side: 'before' | 'after' = xRatio < 0.5 ? 'before' : 'after'

    if (tileKind === 'folder' && dragKind === 'folder') {
      // Outer 30 % of width on each side → reorder; centre 40 % → nest into
      if (xRatio < 0.3 || xRatio > 0.7) {
        setInsertAt({ id: tileId, side })
        setMoveTargetId(null)
      } else {
        setMoveTargetId(tileId)
        setInsertAt(null)
      }
    } else if (tileKind === 'file' && dragKind === 'file') {
      // Files can't nest — always reorder
      setInsertAt({ id: tileId, side })
      setMoveTargetId(null)
    }
    // Dragging a file over a folder or vice-versa: no cross-section reorder
  }

  function handleTileDrop(e: React.DragEvent, tileId: string) {
    e.preventDefault()
    e.stopPropagation()

    const fileId = e.dataTransfer.getData(FILE_MIME)
    const folderId = e.dataTransfer.getData(FOLDER_MIME)

    // Reorder takes priority over nest when the edge zone was hovered
    if (insertAt && insertAt.id === tileId) {
      if (folderId) {
        const next = spliceItem(folders, folderId, tileId, insertAt.side)
        setFolders(next)
        reorderFolderItems(board.id, next.map(f => f.id), files.map(f => f.id)).catch(console.error)
      } else if (fileId) {
        const next = spliceItem(files, fileId, tileId, insertAt.side)
        setFiles(next)
        reorderFolderItems(board.id, folders.map(f => f.id), next.map(f => f.id)).catch(console.error)
      }
      clearDragState()
      return
    }

    // Centre of a folder — nest into it (existing behaviour)
    if (fileId) {
      moveFileToBoard(fileId, tileId)
    } else if (folderId) {
      moveFolderToBoard(folderId, tileId)
    }
    clearDragState()
  }

  // ── Moving units between boards (drag in/out) ────────────────────────────────

  async function moveFileToBoard(fileId: string, targetBoardId: string) {
    if (!fileId || targetBoardId === board.id) return
    setFiles(prev => prev.filter(f => f.id !== fileId))
    setMoveTargetId(null)
    await moveElementToBoard(fileId, targetBoardId, board.id)
  }

  async function moveFolderToBoard(folderId: string, targetBoardId: string | null) {
    if (!folderId || folderId === targetBoardId) return
    const moved = folders.find(f => f.id === folderId)
    setFolders(prev => prev.filter(f => f.id !== folderId))
    setMoveTargetId(null)
    try {
      await moveBoardToParent(folderId, targetBoardId, board.id)
    } catch (err) {
      if (moved) setFolders(prev => [...prev, moved])
      alert(err instanceof Error ? err.message : 'Could not move that folder.')
    }
  }

  // Drop onto the "Back" button or empty space moves items up/out
  function handleBackDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation()
    const fileId = e.dataTransfer.getData(FILE_MIME)
    if (fileId && board.parent_id) { moveFileToBoard(fileId, board.parent_id); return }
    const folderId = e.dataTransfer.getData(FOLDER_MIME)
    if (folderId) moveFolderToBoard(folderId, board.parent_id)
    clearDragState()
  }

  // ── Creating units ───────────────────────────────────────────────────────────

  async function createBoardUnit(mode: CreateMode, name: string) {
    setCreateMenu(null)
    const sub = await createSubTab(board.id, name, board.color, mode)
    setFolders(prev => [...prev, sub as Board])
  }
  async function createFileUnit() {
    setCreateMenu(null)
    const el = await createTextFile(board.id, 'Untitled.txt', '')
    setFiles(prev => [...prev, el as BoardElement])
    setEditing(el as BoardElement)
  }
  async function handleNewFolder() {
    const sub = await createSubTab(board.id, 'New folder', board.color, 'folder')
    setFolders(prev => [...prev, sub as Board])
  }

  async function removeFolder(id: string) {
    setFolders(prev => prev.filter(f => f.id !== id))
    await deleteBoard(id)
  }
  async function removeFile(id: string) {
    setFiles(prev => prev.filter(f => f.id !== id))
    await deleteElement(id)
  }
  async function saveEditing() {
    if (!editing) return
    const name = (editing.data.name as string) || 'Untitled.txt'
    const content = (editing.data.content as string) || ''
    setFiles(prev => prev.map(f => f.id === editing.id ? editing : f))
    setEditing(null)
    await updateTextFile(editing.id, name, content, board.id)
  }

  // ── Selection: click to select, drag the background to marquee-select ────────

  function toggleSelect(id: string, additive: boolean) {
    setSelected(prev => {
      const next = new Set(additive ? prev : [])
      if (additive && prev.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function onSurfaceMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-unit-id]')) return
    marqueeStart.current = { x: e.clientX, y: e.clientY, moved: false }
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setSelected(new Set())
  }

  useEffect(() => {
    function move(e: MouseEvent) {
      const s = marqueeStart.current; if (!s) return
      const dx = e.clientX - s.x, dy = e.clientY - s.y
      if (!s.moved && Math.hypot(dx, dy) < 5) return
      s.moved = true
      const x = Math.min(s.x, e.clientX), y = Math.min(s.y, e.clientY), w = Math.abs(dx), h = Math.abs(dy)
      setMarquee({ x, y, w, h })
      const next = new Set<string>()
      document.querySelectorAll<HTMLElement>('[data-unit-id]').forEach(el => {
        const r = el.getBoundingClientRect()
        if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) next.add(el.dataset.unitId!)
      })
      setSelected(next)
    }
    function up(e: MouseEvent) {
      const s = marqueeStart.current; if (!s) return
      marqueeStart.current = null; setMarquee(null)
      if (!s.moved) setCreateMenu({ x: e.clientX, y: e.clientY })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  // Delete key removes the current selection
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key !== 'Delete' || selected.size === 0 || editing) return
      e.preventDefault()
      const ids = [...selected]
      const folderIds = ids.filter(id => folders.some(f => f.id === id))
      const fileIds = ids.filter(id => files.some(f => f.id === id))
      if (folderIds.length && !confirm(`Delete ${folderIds.length} folder(s) and everything inside?`)) return
      setFolders(prev => prev.filter(f => !folderIds.includes(f.id)))
      setFiles(prev => prev.filter(f => !fileIds.includes(f.id)))
      setSelected(new Set())
      folderIds.forEach(id => deleteBoard(id).catch(() => {}))
      fileIds.forEach(id => deleteElement(id).catch(() => {}))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, editing, folders, files])

  // ── Publish contents to the sidebar dashboard ────────────────────────────────

  useEffect(() => {
    folderUnitsStore.publish([
      ...folders.map(f => ({ id: f.id, name: f.name, kind: 'folder' as const, mode: f.mode })),
      ...files.map(f => ({ id: f.id, name: (f.data.name as string) || 'Untitled.txt', kind: 'file' as const })),
    ])
  }, [folders, files])

  useEffect(() => {
    folderUnitsStore.setHandlers({
      open: (id, kind) => {
        if (kind === 'folder') router.push(`/board/${id}`)
        else { const file = files.find(x => x.id === id); if (file) setEditing(file) }
      },
    })
  }, [files, router])

  useEffect(() => () => folderUnitsStore.clear(), [])

  // ── OS file/folder drop ──────────────────────────────────────────────────────

  function onDragOver(e: React.DragEvent) {
    if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
  }
  function onDragEnter(e: React.DragEvent) {
    if (Array.from(e.dataTransfer.types).includes('Files')) { dragDepth.current++; setDragOver(true) }
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  async function onDrop(e: React.DragEvent) {
    dragDepth.current = 0; setDragOver(false)
    if (e.dataTransfer.getData(FILE_MIME) || e.dataTransfer.getData(FOLDER_MIME)) return
    const entries = collectEntries(e.dataTransfer)
    if (!entries && !e.dataTransfer.files?.length) return
    e.preventDefault()
    const { trees, files: dropped, pdfs, binaries, skipped } = await readDroppedEntries(entries, e.dataTransfer.files)
    for (const f of dropped) { const el = await createTextFile(board.id, f.name, f.content); setFiles(prev => [...prev, el as BoardElement]) }
    for (const pdf of pdfs) {
      try {
        let { key: storagePath, sizeBytes } = await uploadPdf(pdf, board.id)
        let text = '', pageCount = 0
        try { ;({ text, pageCount } = await extractPdfText(pdf)) } catch { /* keep PDF without text */ }
        const el = await createElement(board.id, 'pdf', 0, 0, { name: pdf.name, storagePath, sizeBytes, text, pageCount })
        setFiles(prev => [...prev, el as BoardElement])
      } catch (err) { console.error('Failed to add PDF:', err) }
    }
    for (const file of binaries) {
      try {
        const { key: storagePath, sizeBytes } = await uploadFile(file, board.id)
        const el = await createElement(board.id, 'file', 0, 0, { name: file.name, storagePath, sizeBytes })
        setFiles(prev => [...prev, el as BoardElement])
      } catch (err) { console.error('Failed to add file:', err) }
    }
    for (const tree of trees) {
      const uploadedKeys: string[] = []
      const failed: string[] = []
      try {
        const serverTree = await buildUploadTree(tree, board.id, uploadedKeys, failed)
        const top = await importFolderTree(board.id, serverTree, board.color)
        setFolders(prev => [...prev, top as Board])
      } catch (err) {
        console.error('Failed to import dragged folder:', err)
        if (uploadedKeys.length) deleteStorageObjects(uploadedKeys).catch(() => {})
      }
    }
  }

  // ── Upload a folder via the picker button ────────────────────────────────────

  async function onFolderPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files
    if (!list || list.length === 0) return
    setUploading('Reading…')
    const failed: string[] = []
    let importFailed = false
    try {
      const { roots, skipped } = await readPickedFolder(list)
      if (!roots.length) { alert('That folder had no importable files.'); return }
      setUploading('Uploading…')
      for (const root of roots) {
        const uploadedKeys: string[] = []
        try {
          const tree = await buildUploadTree(root, board.id, uploadedKeys, failed)
          const top = await importFolderTree(board.id, tree, board.color)
          setFolders(prev => [...prev, top as Board])
        } catch (err) {
          // This root failed to persist — its just-uploaded files are now orphaned
          // in R2 (no element references them), so best-effort clean them up.
          console.error('Folder import failed for:', root.name, err)
          importFailed = true
          if (uploadedKeys.length) deleteStorageObjects(uploadedKeys).catch(() => {})
          break
        }
      }
      const notes: string[] = []
      if (importFailed) notes.push('Some folders could not be imported and were rolled back.')
      if (failed.length) notes.push(`${failed.length} file(s) could not be uploaded and were skipped.`)
      if (skipped.length) notes.push(`${skipped.length} file(s) were too large and were skipped (max 100 MB each).`)
      if (notes.length) alert(notes.join('\n'))
    } catch (err) {
      console.error('Folder upload failed:', err)
      alert('Could not upload that folder.')
    } finally {
      setUploading(null)
      if (folderInputRef.current) folderInputRef.current.value = '' // allow re-picking the same folder
    }
  }

  async function openPdf(path: string) {
    const w = window.open('', '_blank')
    try {
      const res = await getPdfUrl(path)
      if (res.ok && res.url && w) w.location.href = res.url
      else if (w) w.close()
    } catch { if (w) w.close() }
  }

  // Open any stored file (opaque 'file' unit) via a presigned URL — the browser
  // downloads or previews it depending on type. Tab opened before the await so
  // popup blockers allow it.
  async function openStored(path?: string) {
    if (!path) return
    const w = window.open('', '_blank')
    try {
      const res = await getPresignedReadUrl(path)
      if (res.ok && res.url && w) w.location.href = res.url
      else if (w) w.close()
    } catch { if (w) w.close() }
  }

  const isEmpty = folders.length === 0 && files.length === 0

  // ── Render ───────────────────────────────────────────────────────────────────

  // Visual class for a tile based on current drag/selection state.
  function folderTileClass(f: Board) {
    const isInsertBefore = insertAt?.id === f.id && insertAt.side === 'before'
    const isInsertAfter  = insertAt?.id === f.id && insertAt.side === 'after'
    const isNestTarget   = moveTargetId === f.id
    const isSel          = selected.has(f.id)
    const isDragging     = draggingId === f.id

    return [
      'group relative flex flex-col items-center gap-1.5 p-3 rounded-lg cursor-pointer transition-colors',
      isNestTarget  ? 'bg-blue-100 ring-2 ring-blue-400' :
      isSel         ? 'bg-blue-100 ring-2 ring-blue-500' :
                      'hover:bg-blue-50',
      isDragging ? 'opacity-40' : '',
      isInsertBefore ? 'border-l-[3px] border-l-blue-500' : 'border-l-[3px] border-l-transparent',
      isInsertAfter  ? 'border-r-[3px] border-r-blue-500' : 'border-r-[3px] border-r-transparent',
    ].join(' ')
  }

  function fileTileClass(file: BoardElement) {
    const isInsertBefore = insertAt?.id === file.id && insertAt.side === 'before'
    const isInsertAfter  = insertAt?.id === file.id && insertAt.side === 'after'
    const isSel          = selected.has(file.id)

    return [
      'group relative flex flex-col items-center gap-1.5 p-3 rounded-lg cursor-pointer transition-colors',
      isSel ? 'bg-indigo-100 ring-2 ring-indigo-500' : 'hover:bg-indigo-50',
      isInsertBefore ? 'border-l-[3px] border-l-blue-500' : 'border-l-[3px] border-l-transparent',
      isInsertAfter  ? 'border-r-[3px] border-r-blue-500' : 'border-r-[3px] border-r-transparent',
    ].join(' ')
  }

  return (
    <div
      className="flex-1 h-full flex flex-col bg-gray-50 relative"
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-white">
        <button
          onClick={() => board.parent_id ? router.push(`/board/${board.parent_id}`) : router.push('/')}
          onDragOver={e => {
            const t = e.dataTransfer.types
            const canDrop = (t.includes(FILE_MIME) && board.parent_id) || t.includes(FOLDER_MIME)
            if (canDrop) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
          }}
          onDrop={handleBackDrop}
          className="p-1.5 rounded text-gray-500 hover:bg-gray-100"
          title={board.parent_id ? 'Back (drop here to move up)' : 'Back'}
        >
          <ArrowLeft size={16} />
        </button>
        <Folder size={16} className="text-gray-400" />
        <span className="text-sm font-medium text-gray-700">{board.name}</span>
        <span className="text-xs text-gray-400">· {folders.length + files.length} items</span>
        <div className="flex-1" />
        <button
          onClick={() => folderInputRef.current?.click()}
          disabled={!!uploading}
          className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
          title="Upload a folder from your computer — its structure becomes folders and files here"
        >
          <Upload size={14} /> {uploading ?? 'Upload folder'}
        </button>
        <button onClick={handleNewFolder} className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
          <FolderPlus size={14} /> New folder
        </button>
        {/* Hidden folder picker. webkitdirectory/directory are set imperatively
            since React has no typed props for them. */}
        <input
          ref={el => {
            folderInputRef.current = el
            if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') }
          }}
          type="file"
          multiple
          className="hidden"
          onChange={onFolderPicked}
        />
      </div>

      <BoardReadme boardId={board.id} initialReadme={board.readme_md ?? null} />

      {/* Grid */}
      <div
        className="flex-1 overflow-auto p-4"
        onMouseDown={onSurfaceMouseDown}
        onContextMenu={e => {
          if (!(e.target as HTMLElement).closest('[data-unit-id]')) {
            e.preventDefault(); setCreateMenu({ x: e.clientX, y: e.clientY })
          }
        }}
      >
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400 pointer-events-none">
            <FileText size={40} className="mb-3 opacity-40" />
            <p className="text-sm">This folder is empty.</p>
            <p className="text-xs mt-1">Click anywhere to create · drag in files or folders.</p>
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}>
            {/* ── Folder tiles ── */}
            {folders.map(f => (
              <div
                key={f.id}
                data-unit-id={f.id}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData(FOLDER_MIME, f.id)
                  e.dataTransfer.effectAllowed = 'move'
                  draggingIdRef.current = f.id
                  draggingKindRef.current = 'folder'
                  setDraggingId(f.id)
                }}
                onDragEnd={clearDragState}
                onDragOver={e => computeDragIntent(e, f.id, 'folder')}
                onDragLeave={() => {
                  if (moveTargetId === f.id) setMoveTargetId(null)
                  if (insertAt?.id === f.id) setInsertAt(null)
                }}
                onDrop={e => handleTileDrop(e, f.id)}
                onClick={e => { e.stopPropagation(); toggleSelect(f.id, e.ctrlKey || e.metaKey || e.shiftKey) }}
                onDoubleClick={() => router.push(`/board/${f.id}`)}
                className={folderTileClass(f)}
                title="Double-click to open · drag edges to reorder · drag centre to nest · click ⌄ for settings"
              >
                <div className="relative">
                  <Folder size={44} className="text-blue-400 fill-blue-100" />
                  {f.mode !== 'folder' && (
                    <span className="absolute -bottom-1 -right-1 text-[11px]">{MODE_EMOJI[f.mode] ?? ''}</span>
                  )}
                </div>
                <span className="text-[11px] text-gray-700 text-center break-words line-clamp-2 leading-tight">{f.name}</span>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setFileMenu(null)
                    setFolderPanel({ boardId: f.id, rect })
                  }}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-white shadow text-gray-400 hover:text-gray-700"
                  title="Settings"
                >
                  <ChevronDown size={12} />
                </button>
              </div>
            ))}

            {/* ── File tiles ── */}
            {files.map(file => (
              <div
                key={file.id}
                data-unit-id={file.id}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData(FILE_MIME, file.id)
                  e.dataTransfer.effectAllowed = 'move'
                  draggingIdRef.current = file.id
                  draggingKindRef.current = 'file'
                  setDraggingId(file.id)
                }}
                onDragEnd={clearDragState}
                onDragOver={e => computeDragIntent(e, file.id, 'file')}
                onDragLeave={() => { if (insertAt?.id === file.id) setInsertAt(null) }}
                onDrop={e => handleTileDrop(e, file.id)}
                onClick={e => { e.stopPropagation(); toggleSelect(file.id, e.ctrlKey || e.metaKey || e.shiftKey) }}
                onDoubleClick={async () => {
                  if (file.type === 'pdf') { openPdf(file.data.storagePath as string); return }
                  if (file.type === 'file') { openStored(file.data.storagePath as string); return }
                  if (file.data.storagePath && !file.data.content) {
                    try {
                      const r = await getPresignedReadUrl(file.data.storagePath as string)
                      const res = r.ok && r.url ? await fetch(r.url) : null
                      const text = res?.ok ? await res.text() : ''
                      setEditing({ ...file, data: { ...file.data, content: text } })
                    } catch { setEditing(file) }
                  } else {
                    setEditing(file)
                  }
                }}
                className={fileTileClass(file)}
                title={file.type === 'pdf' ? 'Double-click to open the PDF in a new tab' : file.type === 'file' ? 'Stored file — double-click to open/download' : 'Double-click to open · drag to reorder · click ⌄ for settings'}
              >
                {file.type === 'pdf'
                  ? <FileType size={42} className="text-red-400" />
                  : file.type === 'file'
                  ? <FileIcon size={42} className="text-gray-400" />
                  : <FileText size={42} className="text-indigo-400" />}
                <span className="text-[11px] text-gray-700 text-center break-words line-clamp-2 leading-tight">
                  {(file.data.name as string) || (file.type === 'pdf' ? 'Document.pdf' : file.type === 'file' ? 'File' : 'Untitled.txt')}
                </span>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setFolderPanel(null)
                    setFileMenu({ fileId: file.id, rect })
                  }}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-white shadow text-gray-400 hover:text-gray-700"
                  title="Settings"
                >
                  <ChevronDown size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Marquee rectangle */}
      {marquee && (
        <div
          className="fixed z-30 border border-blue-400 bg-blue-400/15 pointer-events-none"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      {/* Create menu */}
      {createMenu && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCreateMenu(null)} onContextMenu={e => { e.preventDefault(); setCreateMenu(null) }} />
          <div
            style={{ position: 'fixed', top: Math.min(createMenu.y, window.innerHeight - 230), left: Math.min(createMenu.x, window.innerWidth - 184), zIndex: 50 }}
            className="bg-white rounded-lg shadow-xl border border-gray-200 py-1 w-44 text-sm"
          >
            <p className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Create</p>
            <button onClick={createFileUnit} className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-100 text-left">📄 New text file</button>
            {CREATE_OPTIONS.map(o => (
              <button key={o.mode} onClick={() => createBoardUnit(o.mode, o.name)} className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-100 text-left">
                {o.emoji} {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}

      {/* Drop overlay (OS file/folder import) */}
      {dragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-indigo-500/10 border-4 border-dashed border-indigo-400 pointer-events-none">
          <p className="bg-white/90 text-indigo-600 text-sm font-medium px-4 py-2 rounded-lg shadow">Drop files or folders here</p>
        </div>
      )}

      {/* Folder settings panel */}
      {folderPanel && (() => {
        const f = folders.find(x => x.id === folderPanel.boardId)
        if (!f) return null
        return (
          <BoardPropertiesPanel
            board={f}
            anchorRect={folderPanel.rect}
            showAddSubTab={false}
            onClose={() => setFolderPanel(null)}
            onUpdate={updated => { setFolders(prev => prev.map(x => x.id === updated.id ? updated : x)); setFolderPanel(null) }}
            onRemove={() => { setFolderPanel(null); removeFolder(f.id) }}
          />
        )
      })()}

      {/* File settings panel */}
      {fileMenu && (() => {
        const f = files.find(x => x.id === fileMenu.fileId)
        if (!f) return null
        return (
          <FileMenuPanel
            file={f}
            boardId={board.id}
            anchorRect={fileMenu.rect}
            onClose={() => setFileMenu(null)}
            onOpen={() => openStored(f.data.storagePath as string | undefined)}
            onSaved={updated => { setFiles(prev => prev.map(x => x.id === updated.id ? updated : x)); setFileMenu(null) }}
            onDeleted={() => { setFileMenu(null); removeFile(f.id) }}
          />
        )
      })()}

      {/* File editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => saveEditing()}>
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
              <FileText size={15} className="text-indigo-500 shrink-0" />
              <input
                value={(editing.data.name as string) || ''}
                onChange={e => setEditing({ ...editing, data: { ...editing.data, name: e.target.value } })}
                className="flex-1 text-sm font-medium text-gray-800 focus:outline-none"
                placeholder="filename.txt"
              />
              <button
                onClick={() => downloadTextFile((editing.data.name as string) || 'file.txt', (editing.data.content as string) || '')}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 px-2 py-1 rounded hover:bg-gray-100"
                title="Download"
              >
                <Download size={13} /> Download
              </button>
              <button onClick={saveEditing} className="flex items-center gap-1 text-xs bg-indigo-500 hover:bg-indigo-600 text-white px-2.5 py-1 rounded">
                <Save size={12} /> Save
              </button>
              <button onClick={() => setEditing(null)} className="p-1 text-gray-400 hover:text-gray-700"><X size={16} /></button>
            </div>
            <textarea
              autoFocus
              value={(editing.data.content as string) || ''}
              onChange={e => setEditing({ ...editing, data: { ...editing.data, content: e.target.value } })}
              className="flex-1 p-3 text-sm font-mono text-gray-800 resize-none focus:outline-none min-h-[50vh]"
              placeholder="File contents…"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Per-file settings menu ────────────────────────────────────────────────────

function FileMenuPanel({ file, boardId, anchorRect, onClose, onOpen, onSaved, onDeleted }: {
  file: BoardElement; boardId: string; anchorRect: DOMRect
  onClose: () => void; onOpen: () => void; onSaved: (f: BoardElement) => void; onDeleted: () => void
}) {
  const isStored = !!file.data.storagePath && !file.data.content
  const [name, setName] = useState((file.data.name as string) || '')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    setTimeout(() => document.addEventListener('mousedown', onClick), 0)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  async function save() {
    const finalName = name.trim() || 'Untitled.txt'
    const content = (file.data.content as string) || ''
    await updateTextFile(file.id, finalName, content, boardId)
    onSaved({ ...file, data: { ...file.data, name: finalName } })
  }

  return createPortal(
    <div
      ref={ref}
      style={{ position: 'fixed', top: anchorRect.bottom + 6, left: Math.min(anchorRect.left, window.innerWidth - 232), zIndex: 9999 }}
      className="bg-white rounded-lg shadow-xl border border-gray-200 p-3 w-56"
    >
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">File</p>
      <input
        autoFocus value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save() }}
        className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-2 focus:outline-none focus:border-blue-500"
        placeholder="filename.txt"
      />
      <button onClick={save} className="w-full bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm py-1.5 rounded mb-1.5">Save</button>
      <button
        onClick={() => isStored ? onOpen() : downloadTextFile((file.data.name as string) || 'file.txt', (file.data.content as string) || '')}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-600 hover:bg-gray-100 py-1.5 rounded mb-1"
      >
        <Download size={12} /> {isStored ? 'Open / download' : 'Download'}
      </button>
      <button onClick={onDeleted} className="w-full flex items-center justify-center gap-1.5 text-xs text-red-600 hover:bg-red-50 py-1.5 rounded">
        <Trash2 size={12} /> Delete
      </button>
    </div>,
    document.body
  )
}
