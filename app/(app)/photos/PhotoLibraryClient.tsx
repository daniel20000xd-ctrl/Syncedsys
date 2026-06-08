'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Download, Trash2, Bookmark, BookmarkCheck, PauseCircle, PlayCircle, Camera, Pencil, Check, X } from 'lucide-react'
import type { WorkspacePhotoWithUrl, PhotoLibrarySettings } from '@/lib/types'

// ── helpers ────────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function expiryLabel(photo: WorkspacePhotoWithUrl, paused: boolean): { text: string; color: string } {
  if (photo.is_saved) return { text: 'Saved', color: 'text-green-600' }
  if (paused) return { text: 'Deletion paused', color: 'text-amber-500' }
  if (!photo.expires_at) return { text: 'No expiry', color: 'text-gray-400' }
  const ms = new Date(photo.expires_at).getTime() - Date.now()
  if (ms <= 0) return { text: 'Expired', color: 'text-red-500' }
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24))
  return { text: `Expires in ${days}d`, color: days <= 2 ? 'text-amber-500' : 'text-gray-400' }
}

// ── inline description editor ──────────────────────────────────────────────────

function DescriptionCell({ photo, onSave }: { photo: WorkspacePhotoWithUrl; onSave: (id: string, desc: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(photo.description ?? '')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setDraft(photo.description ?? '') }, [photo.description])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  async function commit() {
    if (draft === (photo.description ?? '')) { setEditing(false); return }
    setSaving(true)
    await onSave(photo.id, draft)
    setSaving(false)
    setEditing(false)
  }

  function cancel() { setDraft(photo.description ?? ''); setEditing(false) }

  if (editing) {
    return (
      <div className="flex items-start gap-1.5">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() } if (e.key === 'Escape') cancel() }}
          rows={2}
          className="flex-1 text-xs px-2 py-1 border border-blue-300 rounded resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
          placeholder="Add a description…"
          disabled={saving}
        />
        <div className="flex flex-col gap-1 mt-0.5">
          <button onClick={commit} disabled={saving} className="p-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"><Check size={11} /></button>
          <button onClick={cancel} className="p-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200"><X size={11} /></button>
        </div>
      </div>
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group/desc flex items-start gap-1.5 text-left w-full"
    >
      {photo.description
        ? <span className="text-xs text-gray-600 leading-snug flex-1">{photo.description}</span>
        : <span className="text-xs text-gray-300 italic flex-1">Add description…</span>
      }
      <Pencil size={11} className="text-gray-300 group-hover/desc:text-gray-500 shrink-0 mt-0.5" />
    </button>
  )
}

// ── main component ─────────────────────────────────────────────────────────────

export default function PhotoLibraryClient() {
  const [photos, setPhotos] = useState<WorkspacePhotoWithUrl[]>([])
  const [settings, setSettings] = useState<PhotoLibrarySettings>({ pause_deletion: false })
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'saved'>('all')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function flash(text: string, ok = true) {
    if (statusTimer.current) clearTimeout(statusTimer.current)
    setStatusMsg({ text, ok })
    statusTimer.current = setTimeout(() => setStatusMsg(null), 3000)
  }

  const load = useCallback(async (filter: 'all' | 'saved') => {
    setLoading(true)
    try {
      const [photosRes, settingsRes] = await Promise.all([
        fetch(filter === 'saved' ? '/api/photos?saved=true' : '/api/photos'),
        fetch('/api/photos/settings'),
      ])
      if (!photosRes.ok) throw new Error()
      const [photosData, settingsData] = await Promise.all([photosRes.json(), settingsRes.json()])
      setPhotos(photosData)
      setSettings(settingsData)
    } catch {
      flash('Failed to load photos', false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab) }, [load, tab])

  async function togglePause() {
    const next = !settings.pause_deletion
    setSettings(s => ({ ...s, pause_deletion: next }))
    const res = await fetch('/api/photos/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_deletion: next }),
    })
    if (!res.ok) {
      setSettings(s => ({ ...s, pause_deletion: !next }))
      flash('Could not update setting', false)
    } else {
      flash(next ? 'Auto-deletion paused' : 'Auto-deletion resumed')
    }
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
      flash('Could not update photo', false)
    } else {
      flash(next ? 'Photo saved — will not be auto-deleted' : 'Auto-deletion restored')
    }
  }

  async function saveDescription(id: string, description: string) {
    const res = await fetch(`/api/photos/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    })
    if (!res.ok) { flash('Could not save description', false); return }
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, description: description.trim() || null } : p))
    flash('Description saved')
  }

  async function downloadPhoto(photo: WorkspacePhotoWithUrl) {
    const res = await fetch(`/api/photos/${photo.id}/download`)
    if (!res.ok) { flash('Download failed', false); return }
    const { url } = await res.json()
    const a = document.createElement('a')
    a.href = url; a.download = photo.filename; a.click()
  }

  async function deletePhoto(id: string) {
    setConfirmId(null)
    const res = await fetch(`/api/photos/${id}`, { method: 'DELETE' })
    if (!res.ok) { flash('Delete failed', false); return }
    setPhotos(prev => prev.filter(p => p.id !== id))
    flash('Photo deleted')
  }

  const displayed = photos

  return (
    <div className="p-8 bg-gray-100 min-h-full overflow-y-auto">
      <div className="max-w-3xl">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-800">Photo Library</h1>
            <p className="text-sm text-gray-500 mt-0.5">Photos uploaded from the iOS companion app.</p>
          </div>
          <div className="flex items-center gap-2">
            {statusMsg && (
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${statusMsg.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {statusMsg.text}
              </span>
            )}
            <button
              onClick={togglePause}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                settings.pause_deletion
                  ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                  : 'bg-white text-gray-600 hover:bg-gray-50 shadow-sm'
              }`}
              title={settings.pause_deletion ? 'Auto-deletion is paused — click to resume' : 'Click to pause auto-deletion indefinitely'}
            >
              {settings.pause_deletion ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
              {settings.pause_deletion ? 'Deletion paused' : 'Pause deletion'}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-white rounded-xl shadow-sm p-1 w-fit">
          {(['all', 'saved'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === t ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {t === 'all' ? 'All' : 'Saved'}
            </button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-white rounded-xl shadow-sm h-16 animate-pulse" />
            ))}
          </div>
        ) : displayed.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm text-center py-20">
            <Camera size={32} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500 text-sm">
              {tab === 'saved' ? 'No saved photos yet.' : 'No photos yet. Upload from the iOS companion app.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {displayed.map(photo => {
              const expiry = expiryLabel(photo, settings.pause_deletion)
              return (
                <div key={photo.id} className="bg-white rounded-xl shadow-sm px-4 py-3 flex items-start gap-4">
                  {/* Number badge */}
                  <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0 mt-0.5">
                    {photo.number}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-800 truncate">{photo.filename}</span>
                      <span className="text-[10px] text-gray-400 shrink-0">{fmtBytes(photo.size_bytes)}</span>
                      <span className={`text-[10px] font-medium shrink-0 ${expiry.color}`}>{expiry.text}</span>
                    </div>
                    <DescriptionCell photo={photo} onSave={saveDescription} />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0 mt-0.5">
                    <button
                      onClick={() => toggleSave(photo)}
                      className={`p-1.5 rounded-lg transition-colors ${photo.is_saved ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
                      title={photo.is_saved ? 'Remove from saved (restore auto-deletion)' : 'Save (exempt from auto-deletion)'}
                    >
                      {photo.is_saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}
                    </button>
                    <button
                      onClick={() => downloadPhoto(photo)}
                      className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                      title="Download"
                    >
                      <Download size={15} />
                    </button>
                    <button
                      onClick={() => setConfirmId(photo.id)}
                      className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40" onClick={() => setConfirmId(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">Delete this photo?</h3>
            <p className="text-sm text-gray-500 mb-5">Removes from R2 storage. Cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => deletePhoto(confirmId)} className="flex-1 bg-red-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-red-700">Delete</button>
              <button onClick={() => setConfirmId(null)} className="flex-1 bg-gray-100 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-200">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
