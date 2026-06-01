'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Folder, FolderPlus, FileText, ArrowLeft, Trash2, X, Save, Download } from 'lucide-react'
import type { Board, BoardElement } from '@/lib/types'
import { createSubTab, renameBoard, deleteBoard, createTextFile, updateTextFile, deleteElement, moveElementToBoard, importFolderTree } from '@/app/actions'
import { collectEntries, readDroppedEntries, downloadTextFile } from '@/lib/files'

const MODE_EMOJI: Record<string, string> = { classic: '🎨', trello: '🗂', text: '📝', folder: '📁' }
// Custom drag type so internal file moves are distinguishable from OS file drops.
const FILE_MIME = 'application/x-syncedsys-fileid'

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
  const [folders, setFolders] = useState<Board[]>(initialFolders)
  const [files, setFiles] = useState<BoardElement[]>(initialFiles)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editing, setEditing] = useState<BoardElement | null>(null)
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null) // folder/back highlighted as a move target
  const dragDepth = useRef(0)

  // ── Move a file into another board (sub-folder, or up to the parent) ──
  async function moveFileToBoard(fileId: string, targetBoardId: string) {
    if (!fileId || targetBoardId === board.id) return
    setFiles(prev => prev.filter(f => f.id !== fileId))
    setMoveTargetId(null)
    await moveElementToBoard(fileId, targetBoardId, board.id)
  }

  // ── Folders ──
  async function handleNewFolder() {
    if (busy) return
    setBusy(true)
    try {
      const sub = await createSubTab(board.id, 'New folder', board.color, 'folder')
      setFolders(prev => [...prev, sub as Board])
      setRenamingId(sub.id)
      setRenameValue('New folder')
    } finally {
      setBusy(false)
    }
  }

  async function commitRename(id: string) {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name) return
    setFolders(prev => prev.map(f => f.id === id ? { ...f, name } : f))
    await renameBoard(id, name)
  }

  async function removeFolder(id: string) {
    if (!confirm('Delete this folder and everything inside it?')) return
    setFolders(prev => prev.filter(f => f.id !== id))
    await deleteBoard(id)
  }

  // ── Files ──
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

  // ── Drag & drop ──
  function onDragOver(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDragEnter(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    dragDepth.current++
    setDragOver(true)
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  async function onDrop(e: React.DragEvent) {
    dragDepth.current = 0
    setDragOver(false)
    // Internal file move dropped on empty space — it already lives here, ignore.
    if (e.dataTransfer.getData(FILE_MIME)) return
    // Grab directory entries synchronously before any await.
    const entries = collectEntries(e.dataTransfer)
    if (!entries && !e.dataTransfer.files?.length) return
    e.preventDefault()
    const { trees, files, skipped } = await readDroppedEntries(entries, e.dataTransfer.files)
    for (const f of files) {
      const el = await createTextFile(board.id, f.name, f.content)
      setFiles(prev => [...prev, el as BoardElement])
    }
    for (const tree of trees) {
      const top = await importFolderTree(board.id, tree, board.color)
      setFolders(prev => [...prev, top as Board])
    }
    if (skipped.length && !files.length && !trees.length) {
      alert('Only text files are supported for now (binary storage is coming later).')
    }
  }

  const isEmpty = folders.length === 0 && files.length === 0

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
          onDragOver={e => { if (board.parent_id && e.dataTransfer.types.includes(FILE_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setMoveTargetId('__back__') } }}
          onDragLeave={() => setMoveTargetId(null)}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData(FILE_MIME); if (id && board.parent_id) moveFileToBoard(id, board.parent_id) }}
          className={`p-1.5 rounded text-gray-500 ${moveTargetId === '__back__' ? 'bg-blue-100 ring-2 ring-blue-400' : 'hover:bg-gray-100'}`}
          title={board.parent_id ? 'Back (drop a file here to move it up)' : 'Back'}
        >
          <ArrowLeft size={16} />
        </button>
        <Folder size={16} className="text-gray-400" />
        <span className="text-sm font-medium text-gray-700">{board.name}</span>
        <span className="text-xs text-gray-400">· {folders.length + files.length} items</span>
        <div className="flex-1" />
        <button
          onClick={handleNewFolder}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
        >
          <FolderPlus size={14} /> New folder
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto p-4">
        {isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <FileText size={40} className="mb-3 opacity-40" />
            <p className="text-sm">This folder is empty.</p>
            <p className="text-xs mt-1">Drag in files or whole folders, or create a sub-folder.</p>
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}>
            {folders.map(f => (
              <div
                key={f.id}
                onDoubleClick={() => router.push(`/board/${f.id}`)}
                onDragOver={e => { if (e.dataTransfer.types.includes(FILE_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setMoveTargetId(f.id) } }}
                onDragLeave={() => setMoveTargetId(prev => prev === f.id ? null : prev)}
                onDrop={e => { e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData(FILE_MIME); if (id) moveFileToBoard(id, f.id) }}
                className={`group relative flex flex-col items-center gap-1.5 p-3 rounded-lg cursor-pointer ${moveTargetId === f.id ? 'bg-blue-100 ring-2 ring-blue-400' : 'hover:bg-blue-50'}`}
                title="Double-click to open · drop a file here to move it in"
              >
                <div className="relative">
                  <Folder size={44} className="text-blue-400 fill-blue-100" />
                  {f.mode !== 'folder' && (
                    <span className="absolute -bottom-1 -right-1 text-[11px]">{MODE_EMOJI[f.mode] ?? ''}</span>
                  )}
                </div>
                {renamingId === f.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(f.id)}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(f.id); if (e.key === 'Escape') setRenamingId(null) }}
                    onDoubleClick={e => e.stopPropagation()}
                    className="w-full text-[11px] text-center border border-blue-400 rounded px-1 focus:outline-none"
                  />
                ) : (
                  <span
                    className="text-[11px] text-gray-700 text-center break-words line-clamp-2 leading-tight"
                    onClick={e => { e.stopPropagation(); setRenamingId(f.id); setRenameValue(f.name) }}
                    title="Click to rename"
                  >
                    {f.name}
                  </span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); removeFolder(f.id) }}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-white shadow text-gray-400 hover:text-red-500"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            {files.map(file => (
              <div
                key={file.id}
                draggable
                onDragStart={e => { e.dataTransfer.setData(FILE_MIME, file.id); e.dataTransfer.effectAllowed = 'move' }}
                onDoubleClick={() => setEditing(file)}
                className="group relative flex flex-col items-center gap-1.5 p-3 rounded-lg hover:bg-indigo-50 cursor-pointer"
                title="Double-click to open · drag onto a folder to move it"
              >
                <FileText size={42} className="text-indigo-400" />
                <span className="text-[11px] text-gray-700 text-center break-words line-clamp-2 leading-tight">
                  {(file.data.name as string) || 'Untitled.txt'}
                </span>
                <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 flex gap-0.5">
                  <button
                    onClick={e => { e.stopPropagation(); downloadTextFile((file.data.name as string) || 'file.txt', (file.data.content as string) || '') }}
                    className="p-0.5 rounded bg-white shadow text-gray-400 hover:text-indigo-500"
                    title="Download"
                  >
                    <Download size={11} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); removeFile(file.id) }}
                    className="p-0.5 rounded bg-white shadow text-gray-400 hover:text-red-500"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-indigo-500/10 border-4 border-dashed border-indigo-400 pointer-events-none">
          <p className="bg-white/90 text-indigo-600 text-sm font-medium px-4 py-2 rounded-lg shadow">Drop files or folders here</p>
        </div>
      )}

      {/* File editor */}
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
