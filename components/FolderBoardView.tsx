'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Folder, FolderPlus, FileText, ArrowLeft, Trash2, X, Save } from 'lucide-react'
import type { Board, BoardElement } from '@/lib/types'
import { createSubTab, renameBoard, deleteBoard, createTextFile, updateTextFile, deleteElement } from '@/app/actions'
import { readDroppedTextFiles } from '@/lib/files'

const MODE_EMOJI: Record<string, string> = { classic: '🎨', trello: '🗂', text: '📝', folder: '📁' }

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
  const dragDepth = useRef(0)

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
    if (!e.dataTransfer.files?.length) return
    e.preventDefault()
    const { accepted, skipped } = await readDroppedTextFiles(e.dataTransfer.files)
    for (const f of accepted) {
      const el = await createTextFile(board.id, f.name, f.content)
      setFiles(prev => [...prev, el as BoardElement])
    }
    if (skipped.length && !accepted.length) {
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
          className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
          title="Back"
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
            <p className="text-xs mt-1">Drag text files in, or create a sub-folder.</p>
          </div>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}>
            {folders.map(f => (
              <div
                key={f.id}
                onDoubleClick={() => router.push(`/board/${f.id}`)}
                className="group relative flex flex-col items-center gap-1.5 p-3 rounded-lg hover:bg-blue-50 cursor-pointer"
                title="Double-click to open"
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
                onDoubleClick={() => setEditing(file)}
                className="group relative flex flex-col items-center gap-1.5 p-3 rounded-lg hover:bg-indigo-50 cursor-pointer"
                title="Double-click to open"
              >
                <FileText size={42} className="text-indigo-400" />
                <span className="text-[11px] text-gray-700 text-center break-words line-clamp-2 leading-tight">
                  {(file.data.name as string) || 'Untitled.txt'}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); removeFile(file.id) }}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded bg-white shadow text-gray-400 hover:text-red-500"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-indigo-500/10 border-4 border-dashed border-indigo-400 pointer-events-none">
          <p className="bg-white/90 text-indigo-600 text-sm font-medium px-4 py-2 rounded-lg shadow">Drop text files here</p>
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
