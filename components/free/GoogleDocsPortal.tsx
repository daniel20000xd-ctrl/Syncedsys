'use client'

import * as React from 'react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, RefreshCw, ExternalLink, Search, X, FileText, Pencil } from 'lucide-react'
import { getGoogleConnectionStatus } from '@/app/actions'

// Mirrors lib/google/drive.DriveFile — declared locally so this client component
// never imports the server-only drive module (which pulls in token/crypto code).
type DriveFile = { id: string; name: string; modifiedTime: string }

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// A read-only Google Doc viewer in a portal frame. Fetches HTML rendered
// server-side by lib/google/docs.renderDocumentToHtml and shows it in a clean,
// scrollable document. Ctrl+F search highlights matches; a refresh button
// reloads the latest version. No editing — this is a reference viewer.

type ViewerConfig = { documentId?: string }

interface Props {
  config: ViewerConfig
  onPersistConfig: (c: ViewerConfig) => void
  onUpdateContext?: (ctx: string) => void
}

// Scoped document styling (Tailwind preflight strips default element styles).
const DOC_CSS = `
.gdoc { color:#202124; font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; font-size:13px; line-height:1.6; word-wrap:break-word; }
.gdoc h1 { font-size:20px; font-weight:700; margin:0.6em 0 0.3em; line-height:1.3; }
.gdoc h2 { font-size:17px; font-weight:700; margin:0.6em 0 0.3em; }
.gdoc h3 { font-size:15px; font-weight:700; margin:0.5em 0 0.25em; }
.gdoc h4, .gdoc h5, .gdoc h6 { font-size:13px; font-weight:700; margin:0.5em 0 0.25em; }
.gdoc p { margin:0 0 0.5em; }
.gdoc p.subtitle { color:#5f6368; font-size:15px; }
.gdoc p.empty { margin:0 0 0.4em; }
.gdoc ul, .gdoc ol { margin:0 0 0.5em 1.5em; padding:0; }
.gdoc ul { list-style:disc; }
.gdoc ol { list-style:decimal; }
.gdoc li { margin:0.1em 0; }
.gdoc a { color:#1a73e8; text-decoration:underline; }
.gdoc table { border-collapse:collapse; margin:0.6em 0; }
.gdoc td { border:1px solid #bdc1c6; padding:4px 8px; vertical-align:top; }
.gdoc hr { border:0; border-top:1px solid #dadce0; margin:0.8em 0; }
.gdoc hr.page-break { border-top:2px dashed #cbd0d6; margin:1.3em 0; }
.gdoc mark[data-doc-search] { background:#fde047; color:inherit; padding:0; }
`

function parseDocumentId(input: string): string | null {
  const t = input.trim()
  const m = t.match(/\/document\/d\/([a-zA-Z0-9-_]+)/)
  if (m) return m[1]
  if (/^[a-zA-Z0-9-_]{20,}$/.test(t)) return t
  return null
}

function clearHighlights(root: HTMLElement) {
  root.querySelectorAll('mark[data-doc-search]').forEach(m => {
    const parent = m.parentNode
    if (!parent) return
    parent.replaceChild(window.document.createTextNode(m.textContent ?? ''), m)
    parent.normalize()
  })
}

function highlight(root: HTMLElement, query: string): number {
  clearHighlights(root)
  const q = query.toLowerCase()
  if (!q) return 0
  const walker = window.document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const v = node.nodeValue
    if (v && v.toLowerCase().includes(q) && node.parentElement?.tagName !== 'MARK') targets.push(node as Text)
  }
  let count = 0
  for (const tn of targets) {
    const text = tn.nodeValue ?? ''
    const lower = text.toLowerCase()
    const frag = window.document.createDocumentFragment()
    let i = 0
    let idx = lower.indexOf(q)
    while (idx !== -1) {
      if (idx > i) frag.appendChild(window.document.createTextNode(text.slice(i, idx)))
      const mark = window.document.createElement('mark')
      mark.setAttribute('data-doc-search', '1')
      mark.textContent = text.slice(idx, idx + q.length)
      frag.appendChild(mark)
      count++
      i = idx + q.length
      idx = lower.indexOf(q, i)
    }
    if (i < text.length) frag.appendChild(window.document.createTextNode(text.slice(i)))
    tn.parentNode?.replaceChild(frag, tn)
  }
  return count
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] overflow-hidden text-white flex flex-col"
      onPointerDown={e => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

export default function GoogleDocsPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [title, setTitle] = useState('')
  const [html, setHtml] = useState('')
  const [wordCount, setWordCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState(0)

  // Drive file picker (shown when no document is selected yet)
  const [files, setFiles] = useState<DriveFile[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [pickerSearch, setPickerSearch] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)

  // In-portal edit panel
  const [showEdit, setShowEdit] = useState(false)
  const [editMode, setEditMode] = useState<'append' | 'replace'>('append')
  const [appendVal, setAppendVal] = useState('')
  const [findVal, setFindVal] = useState('')
  const [replaceVal, setReplaceVal] = useState('')
  const [saving, setSaving] = useState(false)
  const [editMsg, setEditMsg] = useState<string | null>(null)

  const onContextRef = useRef(onUpdateContext)
  useEffect(() => { onContextRef.current = onUpdateContext }, [onUpdateContext])
  const bodyRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const documentId = config.documentId || null

  // Connection check
  useEffect(() => {
    let cancel = false
    getGoogleConnectionStatus()
      .then(s => { if (!cancel) setConnected(s.connected) })
      .catch(() => { if (!cancel) setConnected(false) })
    return () => { cancel = true }
  }, [])

  const load = useCallback(async (docId: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/google/docs?documentId=${encodeURIComponent(docId)}`, { cache: 'no-store' })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `Failed to load document (${res.status})`)
      }
      const data = (await res.json()) as { title: string; html: string; wordCount: number }
      setTitle(data.title)
      setHtml(data.html)
      setWordCount(data.wordCount)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load document')
    } finally {
      setLoading(false)
    }
    fetch(`/api/google/docs/context?documentId=${encodeURIComponent(docId)}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.text() : null))
      .then(t => { if (t) onContextRef.current?.(t) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (connected && documentId) load(documentId)
  }, [connected, documentId, load])

  // Load the user's Docs from Drive while the picker is showing; debounce search.
  useEffect(() => {
    if (!connected || documentId) return
    let cancel = false
    setPickerLoading(true)
    const term = pickerSearch.trim()
    const t = setTimeout(() => {
      fetch(`/api/google/drive?type=document${term ? `&q=${encodeURIComponent(term)}` : ''}`, { cache: 'no-store' })
        .then(async r => {
          if (!r.ok) {
            const j = await r.json().catch(() => null)
            throw new Error(j?.error ?? `Failed to list documents (${r.status})`)
          }
          return r.json() as Promise<{ files: DriveFile[] }>
        })
        .then(d => { if (!cancel) { setFiles(d.files); setPickerError(null) } })
        .catch(e => { if (!cancel) setPickerError(e instanceof Error ? e.message : 'Failed to list documents') })
        .finally(() => { if (!cancel) setPickerLoading(false) })
    }, term ? 300 : 0)
    return () => { cancel = true; clearTimeout(t) }
  }, [connected, documentId, pickerSearch])

  // Inject the rendered HTML into the (uncontrolled) body container.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.innerHTML = html
    setMatches(query ? highlight(bodyRef.current!, query) : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html])

  // Re-run search highlighting when the query changes.
  useEffect(() => {
    if (bodyRef.current) setMatches(highlight(bodyRef.current, query))
  }, [query])

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      setShowSearch(true)
      setTimeout(() => searchRef.current?.focus(), 0)
    } else if (e.key === 'Escape' && showSearch) {
      setShowSearch(false)
      setQuery('')
    }
  }

  function confirmUrl() {
    const id = parseDocumentId(urlInput)
    if (!id) { setError('That doesn\'t look like a Google Docs URL.'); return }
    setError(null)
    onPersistConfig({ documentId: id })
  }

  async function doEdit() {
    if (!documentId) return
    const payload =
      editMode === 'append'
        ? { documentId, action: 'append', text: appendVal }
        : { documentId, action: 'replace', find: findVal, replace: replaceVal }
    if (editMode === 'append' && !appendVal.trim()) return
    if (editMode === 'replace' && !findVal) return
    setSaving(true)
    setEditMsg(null)
    try {
      const res = await fetch('/api/google/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? `Edit failed (${res.status})`)
      if (editMode === 'append') { setAppendVal(''); setEditMsg('Appended.') }
      else { setFindVal(''); setReplaceVal(''); setEditMsg(`Replaced ${data?.occurrencesChanged ?? 0} occurrence(s).`) }
      await load(documentId)
    } catch (e) {
      setEditMsg(e instanceof Error ? e.message : 'Edit failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (connected === null) {
    return <Shell><div className="flex items-center justify-center flex-1"><Loader2 size={16} className="animate-spin text-white/30" /></div></Shell>
  }
  if (!connected) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 text-center">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white text-sm font-bold">G</span>
          <p className="text-white/60 text-xs">Connect your Google account to view Docs.</p>
          <a href="/settings/connected-apps" className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors">Connect Google Account</a>
        </div>
      </Shell>
    )
  }
  if (!documentId) {
    return (
      <Shell>
        <div className="flex flex-col flex-1 min-h-0">
          {/* Search your Docs */}
          <div className="px-3 pt-3 pb-2 shrink-0">
            <p className="text-white/80 text-xs font-medium mb-2">Open a Google Doc</p>
            <div className="flex items-center gap-1.5 bg-white/5 rounded px-2 py-1.5">
              <Search size={12} className="text-white/30 shrink-0" />
              <input
                value={pickerSearch}
                onChange={e => setPickerSearch(e.target.value)}
                placeholder="Search your Docs"
                autoFocus
                className="flex-1 min-w-0 bg-transparent text-xs text-white placeholder-white/30 focus:outline-none"
              />
              {pickerLoading && <Loader2 size={12} className="animate-spin text-white/30 shrink-0" />}
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto min-h-0 px-1.5">
            {pickerError && <p className="px-2 py-2 text-[11px] text-red-400/80">{pickerError}</p>}
            {!pickerError && !pickerLoading && files.length === 0 && (
              <p className="px-2 py-6 text-center text-[11px] text-white/30">
                {pickerSearch.trim() ? 'No documents match.' : 'No documents found.'}
              </p>
            )}
            {files.map(f => (
              <button
                key={f.id}
                onClick={() => { setError(null); onPersistConfig({ documentId: f.id }) }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/10"
              >
                <FileText size={14} className="text-blue-400/80 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-xs text-white/85">{f.name}</span>
                <span className="text-[10px] text-white/30 shrink-0">{relativeTime(f.modifiedTime)}</span>
              </button>
            ))}
          </div>

          {/* Paste-URL fallback */}
          <div className="border-t border-white/10 shrink-0 px-3 py-2">
            {showUrlInput ? (
              <div className="flex items-center gap-1.5">
                <input
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') confirmUrl() }}
                  placeholder="Paste Google Docs URL"
                  autoFocus
                  className="flex-1 min-w-0 bg-white/5 rounded px-2 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-white/30"
                />
                <button onClick={confirmUrl} className="px-2.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium shrink-0">Open</button>
              </div>
            ) : (
              <button onClick={() => setShowUrlInput(true)} className="text-[11px] text-white/40 hover:text-white/70">
                or paste a URL
              </button>
            )}
            {error && <p className="text-red-400/80 text-[11px] mt-1">{error}</p>}
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <style>{DOC_CSS}</style>

      {/* Top bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-white/10 shrink-0" onKeyDown={onKeyDown}>
        <span className="text-xs text-white/80 font-medium truncate flex-1 min-w-0">{title || 'Document'}</span>
        {loading && <Loader2 size={12} className="animate-spin text-white/30 shrink-0" />}
        <button onClick={() => { setShowEdit(s => !s); setEditMsg(null) }} title="Edit" className={`p-1 rounded shrink-0 ${showEdit ? 'bg-blue-600/30 text-blue-300' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}><Pencil size={13} /></button>
        <button onClick={() => setShowSearch(s => !s)} title="Find (Ctrl+F)" className="p-1 rounded text-white/60 hover:bg-white/10 hover:text-white shrink-0"><Search size={13} /></button>
        <button onClick={() => documentId && load(documentId)} title="Refresh" className="p-1 rounded text-white/60 hover:bg-white/10 hover:text-white shrink-0"><RefreshCw size={13} /></button>
        <button
          onClick={() => window.open(`https://docs.google.com/document/d/${documentId}/edit`, '_blank')}
          title="Open in Google Docs"
          className="p-1 rounded text-white/60 hover:bg-white/10 hover:text-white shrink-0"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-1.5 px-2 py-1 border-b border-white/10 shrink-0 bg-[#161922]">
          <Search size={12} className="text-white/30 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setQuery('') } }}
            placeholder="Find in document"
            className="flex-1 min-w-0 bg-transparent text-[11px] text-white placeholder-white/25 focus:outline-none"
          />
          <span className="text-[10px] text-white/40 shrink-0">{query ? `${matches} match${matches === 1 ? '' : 'es'}` : ''}</span>
          <button onClick={() => { setShowSearch(false); setQuery('') }} className="p-0.5 rounded text-white/40 hover:text-white shrink-0"><X size={12} /></button>
        </div>
      )}

      {/* Edit panel */}
      {showEdit && (
        <div className="border-b border-white/10 shrink-0 bg-[#161922] px-2 py-1.5 space-y-1.5">
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setEditMode('append'); setEditMsg(null) }}
              className={`px-2 py-0.5 rounded text-[10px] ${editMode === 'append' ? 'bg-blue-600 text-white' : 'text-white/50 hover:bg-white/10'}`}
            >Append</button>
            <button
              onClick={() => { setEditMode('replace'); setEditMsg(null) }}
              className={`px-2 py-0.5 rounded text-[10px] ${editMode === 'replace' ? 'bg-blue-600 text-white' : 'text-white/50 hover:bg-white/10'}`}
            >Find &amp; replace</button>
            <span className="ml-auto text-[10px] text-white/40 truncate max-w-[45%]">{editMsg}</span>
          </div>

          {editMode === 'append' ? (
            <div className="flex items-start gap-1.5">
              <textarea
                value={appendVal}
                onChange={e => setAppendVal(e.target.value)}
                placeholder="Text to add to the end of the document"
                rows={2}
                className="flex-1 min-w-0 bg-white/5 rounded px-2 py-1 text-[11px] text-white placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-white/30 resize-none"
              />
              <button onClick={doEdit} disabled={saving || !appendVal.trim()} className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[11px] font-medium shrink-0">
                {saving ? '…' : 'Append'}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input value={findVal} onChange={e => setFindVal(e.target.value)} placeholder="Find" className="flex-1 min-w-0 bg-white/5 rounded px-2 py-1 text-[11px] text-white placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-white/30" />
              <input value={replaceVal} onChange={e => setReplaceVal(e.target.value)} placeholder="Replace with" className="flex-1 min-w-0 bg-white/5 rounded px-2 py-1 text-[11px] text-white placeholder-white/25 focus:outline-none focus:ring-1 focus:ring-white/30" />
              <button onClick={doEdit} disabled={saving || !findVal} className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[11px] font-medium shrink-0">
                {saving ? '…' : 'Replace'}
              </button>
            </div>
          )}
          <p className="text-[9px] text-white/25">Edits the real doc via the Docs API. For full formatting, use “Edit in Google Docs”.</p>
        </div>
      )}

      {error && <div className="px-2 py-0.5 text-[10px] text-red-400/80 bg-red-500/10 shrink-0">{error}</div>}

      {/* Document body */}
      <div
        className="flex-1 overflow-auto bg-[#f8f9fa] outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="bg-white mx-auto my-3 px-5 py-4 shadow-sm" style={{ maxWidth: 720 }}>
          <div ref={bodyRef} className="gdoc" />
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center gap-2 px-2 py-0.5 border-t border-white/10 shrink-0 text-[10px] text-white/40">
        <span>{wordCount} word{wordCount === 1 ? '' : 's'} · view only</span>
        <button
          onClick={() => window.open(`https://docs.google.com/document/d/${documentId}/edit`, '_blank')}
          className="ml-auto text-white/40 hover:text-white/70 underline decoration-dotted"
        >
          Edit in Google Docs
        </button>
      </div>
    </Shell>
  )
}
