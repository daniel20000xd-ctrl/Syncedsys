'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Bookmark, BookmarkCheck, Download, Trash2, Image, CheckSquare, Square, X, RefreshCw } from 'lucide-react'
import type { WorkspacePhotoWithUrl } from '@/lib/types'

type Tab = 'all' | 'saved'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function expiryLabel(photo: WorkspacePhotoWithUrl): string {
  if (photo.is_saved) return 'Saved'
  if (!photo.expires_at) return 'No expiry'
  const ms = new Date(photo.expires_at).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24))
  return `Expires in ${days}d`
}

function Toast({ message, type, onDismiss }: { message: string; type: 'ok' | 'err'; onDismiss: () => void }) {
  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium text-white ${
        type === 'ok' ? 'bg-gray-800' : 'bg-red-600'
      }`}
    >
      {message}
      <button onClick={onDismiss} className="ml-1 opacity-70 hover:opacity-100"><X size={13} /></button>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="bg-white rounded-xl shadow-sm overflow-hidden animate-pulse">
          <div className="bg-gray-200 aspect-square" />
          <div className="p-2 space-y-1.5">
            <div className="h-3 bg-gray-200 rounded w-3/4" />
            <div className="h-3 bg-gray-200 rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function PhotosClient() {
  const [photos, setPhotos] = useState<WorkspacePhotoWithUrl[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkMode, setBulkMode] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'ok' | 'err' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(message: string, type: 'ok' | 'err' = 'ok') {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ message, type })
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async (filter: Tab) => {
    setLoading(true)
    try {
      const url = filter === 'saved' ? '/api/photos?saved=true' : '/api/photos'
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to load photos')
      setPhotos(await res.json())
    } catch {
      showToast('Failed to load photos', 'err')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab) }, [load, tab])

  function switchTab(t: Tab) {
    setTab(t)
    setSelected(new Set())
    setBulkMode(false)
  }

  async function toggleSave(photo: WorkspacePhotoWithUrl) {
    const next = !photo.is_saved
    setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, is_saved: next, expires_at: next ? null : p.expires_at } : p))
    const res = await fetch(`/api/photos/${photo.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_saved: next }),
    })
    if (!res.ok) {
      setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, is_saved: photo.is_saved, expires_at: photo.expires_at } : p))
      showToast('Could not update photo', 'err')
    } else {
      showToast(next ? 'Photo saved' : 'Removed from saved')
    }
  }

  async function downloadPhoto(photo: WorkspacePhotoWithUrl) {
    const res = await fetch(`/api/photos/${photo.id}/download`)
    if (!res.ok) { showToast('Download failed', 'err'); return }
    const { url } = await res.json()
    const a = document.createElement('a')
    a.href = url; a.download = photo.filename; a.click()
  }

  async function deletePhoto(id: string) {
    setConfirmDeleteId(null)
    const res = await fetch(`/api/photos/${id}`, { method: 'DELETE' })
    if (!res.ok) { showToast('Delete failed', 'err'); return }
    setPhotos(prev => prev.filter(p => p.id !== id))
    setSelected(prev => { const s = new Set(prev); s.delete(id); return s })
    showToast('Photo deleted')
  }

  async function deleteBulk() {
    setConfirmBulk(false)
    const ids = [...selected]
    const results = await Promise.all(ids.map(id => fetch(`/api/photos/${id}`, { method: 'DELETE' })))
    const failed = results.filter(r => !r.ok).length
    setPhotos(prev => prev.filter(p => !ids.includes(p.id)))
    setSelected(new Set())
    setBulkMode(false)
    if (failed) showToast(`${ids.length - failed} deleted, ${failed} failed`, 'err')
    else showToast(`${ids.length} photo${ids.length !== 1 ? 's' : ''} deleted`)
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  const displayed = photos

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <div className="max-w-5xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-800">Photo Library</h1>
            <p className="text-sm text-gray-500 mt-0.5">Photos are uploaded from the iOS companion app.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => load(tab)}
              className="p-2 rounded-lg text-gray-500 hover:bg-white hover:text-gray-800 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={15} />
            </button>
            <span className="text-xs bg-blue-100 text-blue-700 font-medium px-2.5 py-1 rounded-full">Admin</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-white rounded-xl shadow-sm p-1 w-fit">
          {(['all', 'saved'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {t === 'all' ? 'All' : 'Saved'}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 mb-4 min-h-[36px]">
          <button
            onClick={() => { setBulkMode(v => !v); setSelected(new Set()) }}
            className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium transition-colors ${
              bulkMode ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-white hover:text-gray-800'
            }`}
          >
            {bulkMode ? <CheckSquare size={14} /> : <Square size={14} />}
            Select
          </button>
          {bulkMode && selected.size > 0 && (
            <button
              onClick={() => setConfirmBulk(true)}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              <Trash2 size={14} /> Delete {selected.size}
            </button>
          )}
        </div>

        {/* Grid */}
        {loading ? (
          <SkeletonGrid />
        ) : displayed.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm text-center py-20">
            <Image size={36} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500 text-sm">
              {tab === 'saved' ? 'No saved photos yet.' : 'No photos yet. Upload from the iOS companion app.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {displayed.map(photo => {
              const isHeic = photo.mime_type === 'image/heic'
              const isSel = selected.has(photo.id)
              const label = expiryLabel(photo)
              return (
                <div
                  key={photo.id}
                  className={`group bg-white rounded-xl shadow-sm overflow-hidden relative cursor-default ${
                    bulkMode ? 'cursor-pointer' : ''
                  } ${isSel ? 'ring-2 ring-blue-500' : ''}`}
                  onClick={() => { if (bulkMode) toggleSelect(photo.id) }}
                >
                  {/* Thumbnail */}
                  <div className="aspect-square relative overflow-hidden bg-gray-100">
                    {isHeic ? (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
                        <Image size={28} />
                        <span className="text-[10px] mt-1 font-medium">HEIC</span>
                      </div>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photo.signed_url}
                        alt={photo.filename}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    )}

                    {/* Bulk checkbox */}
                    {bulkMode && (
                      <div className="absolute top-2 left-2">
                        {isSel
                          ? <CheckSquare size={18} className="text-blue-500 fill-white" />
                          : <Square size={18} className="text-white/80 bg-black/20 rounded" />
                        }
                      </div>
                    )}

                    {/* Hover actions */}
                    {!bulkMode && (
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                        <button
                          onClick={e => { e.stopPropagation(); toggleSave(photo) }}
                          className="p-2 bg-white/90 rounded-full text-gray-700 hover:bg-white transition-colors"
                          title={photo.is_saved ? 'Unsave' : 'Save'}
                        >
                          {photo.is_saved ? <BookmarkCheck size={15} className="text-green-600" /> : <Bookmark size={15} />}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); downloadPhoto(photo) }}
                          className="p-2 bg-white/90 rounded-full text-gray-700 hover:bg-white transition-colors"
                          title="Download"
                        >
                          <Download size={15} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setConfirmDeleteId(photo.id) }}
                          className="p-2 bg-white/90 rounded-full text-red-600 hover:bg-white transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Caption */}
                  <div className="p-2">
                    <p className="text-xs text-gray-700 truncate font-medium">{photo.filename}</p>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className={`text-[10px] font-medium ${photo.is_saved ? 'text-green-600' : 'text-gray-400'}`}>
                        {label}
                      </span>
                      <span className="text-[10px] text-gray-400">{fmtBytes(photo.size_bytes)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Delete single confirmation */}
      {confirmDeleteId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40" onClick={() => setConfirmDeleteId(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">Delete photo?</h3>
            <p className="text-sm text-gray-500 mb-5">This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => deletePhoto(confirmDeleteId)} className="flex-1 bg-red-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-red-700">Delete</button>
              <button onClick={() => setConfirmDeleteId(null)} className="flex-1 bg-gray-100 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-200">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete confirmation */}
      {confirmBulk && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40" onClick={() => setConfirmBulk(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">Delete {selected.size} photo{selected.size !== 1 ? 's' : ''}?</h3>
            <p className="text-sm text-gray-500 mb-5">This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={deleteBulk} className="flex-1 bg-red-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-red-700">Delete all</button>
              <button onClick={() => setConfirmBulk(false)} className="flex-1 bg-gray-100 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-200">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}

      {/* Sticky bulk bar */}
      {bulkMode && selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-gray-900 text-white px-5 py-3 rounded-xl shadow-xl">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <button
            onClick={() => setConfirmBulk(true)}
            className="flex items-center gap-1.5 text-sm bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg font-medium transition-colors"
          >
            <Trash2 size={13} /> Delete
          </button>
          <button onClick={() => { setSelected(new Set()); setBulkMode(false) }} className="p-1 opacity-60 hover:opacity-100">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
