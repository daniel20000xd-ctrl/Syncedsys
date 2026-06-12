'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Database, Scale, FileText, ExternalLink, CheckCircle2, Circle,
  Search, ChevronDown, X, Plus, ChevronRight, Loader2,
} from 'lucide-react'
import { updateLibraryItem } from '@/app/actions'
import BoardReadme from './BoardReadme'

type LibraryItemType = 'legal_case' | 'paper'

type LibraryItem = {
  id: string
  type: LibraryItemType
  title: string
  summary: string | null
  tags: string[]
  source_url: string | null
  metadata: Record<string, unknown>
  updated_at: string
  verified: boolean
}

type LibraryItemFull = LibraryItem & { full_text: string | null }

type SortKey = 'date' | 'alpha' | 'verified_last'

const LIMIT = 50

function TypeIcon({ type, size = 14 }: { type: LibraryItemType; size?: number }) {
  if (type === 'legal_case') return <Scale size={size} className="shrink-0 text-[#a78bfa]" />
  return <FileText size={size} className="shrink-0 text-[#60a5fa]" />
}

function metaStr(item: LibraryItem, key: string): string {
  const v = item.metadata[key]
  if (Array.isArray(v)) return v.join(', ')
  return typeof v === 'string' ? v : ''
}

function dateStr(iso: string): string {
  return iso ? iso.slice(0, 10) : ''
}

// ── Detail panel ───────────────────────────────────────────────────────────────

function DetailPanel({
  item: initial,
  onClose,
  onUpdated,
}: {
  item: LibraryItemFull
  onClose: () => void
  onUpdated: (patch: Partial<LibraryItem>) => void
}) {
  const [item, setItem] = useState(initial)
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState(initial.summary ?? '')
  const [newTag, setNewTag] = useState('')
  const [fullTextOpen, setFullTextOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const summaryRef = useRef<HTMLTextAreaElement>(null)

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function saveSummary() {
    if (!editingSummary) return
    setEditingSummary(false)
    const trimmed = summaryDraft.trim()
    if (trimmed === (item.summary ?? '')) return
    setSaving(true)
    const next = { ...item, summary: trimmed || null }
    setItem(next)
    onUpdated({ summary: trimmed || null })
    await updateLibraryItem(item.id, { summary: trimmed || null })
    setSaving(false)
  }

  async function removeTag(tag: string) {
    const tags = item.tags.filter(t => t !== tag)
    setItem(prev => ({ ...prev, tags }))
    onUpdated({ tags })
    await updateLibraryItem(item.id, { tags })
  }

  async function addTag(tag: string) {
    const trimmed = tag.trim()
    if (!trimmed || item.tags.includes(trimmed)) { setNewTag(''); return }
    const tags = [...item.tags, trimmed]
    setItem(prev => ({ ...prev, tags }))
    onUpdated({ tags })
    setNewTag('')
    await updateLibraryItem(item.id, { tags })
  }

  async function toggleVerified() {
    const verified = !item.verified
    setItem(prev => ({ ...prev, verified }))
    onUpdated({ verified })
    await updateLibraryItem(item.id, { verified })
  }

  const isLegal = item.type === 'legal_case'

  return createPortal(
    <div
      className="fixed inset-y-0 right-0 z-[200] flex flex-col w-[420px] border-l border-white/10 overflow-hidden"
      style={{ background: '#1c1c1a' }}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-4 pb-3 border-b border-white/10 shrink-0">
        <TypeIcon type={item.type} size={16} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white leading-tight break-words">{item.title}</p>
          <p className="text-[11px] text-white/40 mt-0.5">
            {item.type === 'legal_case' ? 'Legal case' : 'Paper'} · updated {dateStr(item.updated_at)}
          </p>
        </div>
        {saving && <Loader2 size={13} className="shrink-0 text-white/30 animate-spin mt-0.5" />}
        <button onClick={onClose} className="shrink-0 p-1 rounded text-white/30 hover:text-white hover:bg-white/10 transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

        {/* Metadata fields */}
        {isLegal && (
          <MetaSection>
            <MetaRow label="Beteckning" value={metaStr(item, 'beteckning')} />
            <MetaRow label="Instans" value={metaStr(item, 'instans')} />
            <MetaRow label="Datum" value={metaStr(item, 'datum')} />
            {metaStr(item, 'lagrum') && <MetaRow label="Lagrum" value={metaStr(item, 'lagrum')} />}
            {metaStr(item, 'rubrik') && <MetaRow label="Rubrik" value={metaStr(item, 'rubrik')} />}
          </MetaSection>
        )}
        {!isLegal && (
          <MetaSection>
            {metaStr(item, 'doi') && <MetaRow label="DOI" value={metaStr(item, 'doi')} />}
            {metaStr(item, 'journal') && <MetaRow label="Journal" value={metaStr(item, 'journal')} />}
            {metaStr(item, 'year') && <MetaRow label="Year" value={metaStr(item, 'year')} />}
            {metaStr(item, 'authors') && <MetaRow label="Authors" value={metaStr(item, 'authors')} />}
          </MetaSection>
        )}

        {/* Summary */}
        <div>
          <p className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-1.5">
            {isLegal ? 'Summary' : 'Finding'}
          </p>
          {editingSummary ? (
            <textarea
              ref={summaryRef}
              autoFocus
              value={summaryDraft}
              onChange={e => setSummaryDraft(e.target.value)}
              onBlur={saveSummary}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveSummary() }
                if (e.key === 'Escape') { setEditingSummary(false); setSummaryDraft(item.summary ?? '') }
              }}
              rows={4}
              className="w-full rounded px-2 py-1.5 text-sm text-white bg-white/10 border border-white/20 focus:outline-none focus:border-[#f4a261] resize-none"
            />
          ) : (
            <p
              onClick={() => { setEditingSummary(true); setSummaryDraft(item.summary ?? '') }}
              className="text-sm text-white/70 leading-relaxed cursor-text hover:text-white transition-colors min-h-[2.5rem] rounded px-2 py-1 hover:bg-white/5"
            >
              {item.summary || <span className="text-white/30 italic">Click to add summary…</span>}
            </p>
          )}
        </div>

        {/* Tags */}
        <div>
          <p className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-1.5">Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {item.tags.map(tag => (
              <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-white/10 text-white/70">
                {tag}
                <button onClick={() => removeTag(tag)} className="text-white/30 hover:text-white">
                  <X size={10} />
                </button>
              </span>
            ))}
            <div className="flex items-center gap-1">
              <input
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(newTag) }
                }}
                placeholder="Add tag…"
                className="text-[11px] bg-transparent border border-white/20 rounded-full px-2 py-0.5 text-white/70 focus:outline-none focus:border-[#f4a261] w-24 placeholder:text-white/25"
              />
              {newTag && (
                <button onClick={() => addTag(newTag)} className="text-white/40 hover:text-white">
                  <Plus size={11} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Verified toggle */}
        <div className="flex items-center gap-2">
          <button onClick={toggleVerified} className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors">
            {item.verified
              ? <CheckCircle2 size={16} className="text-emerald-400" />
              : <Circle size={16} className="text-white/30" />}
            <span>{item.verified ? 'Verified' : 'Not verified'}</span>
          </button>
        </div>

        {/* Source URL */}
        {item.source_url && (
          <div>
            <p className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-1">Source</p>
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-[#60a5fa] hover:underline break-all"
            >
              <ExternalLink size={11} />
              {item.source_url}
            </a>
          </div>
        )}

        {/* Full text (collapsed by default) */}
        <div>
          <button
            onClick={() => setFullTextOpen(o => !o)}
            className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            <ChevronRight size={12} className={`transition-transform ${fullTextOpen ? 'rotate-90' : ''}`} />
            {item.full_text ? 'Full text' : 'Full text not yet stored'}
          </button>
          {fullTextOpen && item.full_text && (
            <pre className="mt-2 text-[11px] text-white/50 leading-relaxed whitespace-pre-wrap break-words max-h-80 overflow-y-auto bg-black/20 rounded p-2">
              {item.full_text}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function MetaSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded bg-white/5 border border-white/10 px-3 py-2 space-y-1.5">
      {children}
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-white/40 shrink-0 w-20">{label}</span>
      <span className="text-white/80 break-words">{value}</span>
    </div>
  )
}

// ── Tag filter dropdown ────────────────────────────────────────────────────────

function TagDropdown({
  available,
  selected,
  onChange,
}: {
  available: string[]
  selected: string[]
  onChange: (tags: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  function toggle(tag: string) {
    onChange(selected.includes(tag) ? selected.filter(t => t !== tag) : [...selected, tag])
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 px-2.5 py-1.5 rounded text-xs transition-colors ${
          selected.length ? 'bg-[#f4a261]/20 text-[#f4a261] border border-[#f4a261]/40' : 'bg-white/8 text-white/60 hover:bg-white/12 border border-white/10'
        }`}
      >
        Tags {selected.length > 0 && `(${selected.length})`}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 rounded-lg border border-white/15 shadow-xl w-48 max-h-56 overflow-y-auto py-1" style={{ background: '#2a2a28' }}>
          {available.length === 0 && (
            <p className="px-3 py-2 text-xs text-white/30">No tags in results</p>
          )}
          {available.map(tag => (
            <button
              key={tag}
              onClick={() => toggle(tag)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 text-left transition-colors"
            >
              <span className={`w-3 h-3 rounded-sm border shrink-0 flex items-center justify-center ${selected.includes(tag) ? 'bg-[#f4a261] border-[#f4a261]' : 'border-white/30'}`}>
                {selected.includes(tag) && <span className="text-white text-[8px] font-bold">✓</span>}
              </span>
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DatabaseBoardView({ boardId, config, initialReadme }: { boardId: string; config: string; initialReadme: string | null }) {
  // Parse config — only 'library_items' is a valid source for now.
  const _source = (() => {
    try { return (JSON.parse(config || '{}') as { source?: string }).source || 'library_items' } catch { return 'library_items' }
  })()

  const [items, setItems] = useState<LibraryItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [currentOffset, setCurrentOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'' | 'legal_case' | 'paper'>('')
  const [tagsFilter, setTagsFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortKey>('date')
  const [availableTags, setAvailableTags] = useState<string[]>([])

  const [selected, setSelected] = useState<LibraryItemFull | null>(null)

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const buildParams = useCallback((offset: number) => {
    const p = new URLSearchParams()
    if (search) p.set('q', search)
    if (typeFilter) p.set('type', typeFilter)
    if (tagsFilter.length) p.set('tags', tagsFilter.join(','))
    p.set('sort', sort)
    p.set('limit', String(LIMIT))
    p.set('offset', String(offset))
    return p
  }, [search, typeFilter, tagsFilter, sort])

  // Initial / filter-change fetch
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setFetchError(null)
      try {
        const res = await fetch(`/api/library/search?${buildParams(0)}`)
        if (cancelled) return
        if (!res.ok) {
          const body = await res.text()
          setFetchError(`HTTP ${res.status}: ${body.slice(0, 200)}`)
          setItems([])
          setHasMore(false)
          return
        }
        const data: LibraryItem[] = await res.json()
        setItems(data)
        setCurrentOffset(0)
        setHasMore(data.length === LIMIT)
        const tags = new Set<string>()
        data.forEach(item => item.tags.forEach(t => tags.add(t)))
        setAvailableTags([...tags].sort())
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [search, typeFilter, tagsFilter, sort, buildParams])

  async function loadMore() {
    const nextOffset = currentOffset + LIMIT
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/library/search?${buildParams(nextOffset)}`)
      const data: LibraryItem[] = res.ok ? await res.json() : []
      setItems(prev => [...prev, ...data])
      setCurrentOffset(nextOffset)
      setHasMore(data.length === LIMIT)
      data.forEach(item => item.tags.forEach(t => setAvailableTags(prev => {
        if (prev.includes(t)) return prev
        return [...prev, t].sort()
      })))
    } finally {
      setLoadingMore(false)
    }
  }

  async function openItem(item: LibraryItem) {
    const res = await fetch(`/api/library/item/${item.id}`)
    if (!res.ok) return
    const full: LibraryItemFull = await res.json()
    setSelected(full)
  }

  function handleUpdated(id: string, patch: Partial<LibraryItem>) {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it))
    if (selected?.id === id) setSelected(prev => prev ? { ...prev, ...patch } : prev)
  }

  const hasFilters = !!search || !!typeFilter || tagsFilter.length > 0

  return (
    <div
      className="flex-1 h-full flex flex-col overflow-hidden"
      style={{ background: '#262624', color: '#e5e5e0' }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b shrink-0 flex-wrap"
        style={{ borderColor: 'rgba(255,255,255,0.08)', background: '#30302e' }}
      >
        <Database size={14} className="text-white/40 shrink-0" />

        {/* Search */}
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search title, summary…"
            className="w-full pl-6 pr-2 py-1 rounded text-xs bg-white/8 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:border-white/30"
          />
          {searchInput && (
            <button onClick={() => setSearchInput('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white">
              <X size={10} />
            </button>
          )}
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value as '' | 'legal_case' | 'paper')}
          className="text-xs rounded px-2 py-1.5 bg-white/8 border border-white/10 text-white/70 focus:outline-none focus:border-white/30 cursor-pointer"
          style={{ background: '#30302e' }}
        >
          <option value="">All types</option>
          <option value="legal_case">Legal cases</option>
          <option value="paper">Papers</option>
        </select>

        {/* Tags filter */}
        <TagDropdown available={availableTags} selected={tagsFilter} onChange={setTagsFilter} />

        {/* Sort */}
        <select
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
          className="text-xs rounded px-2 py-1.5 bg-white/8 border border-white/10 text-white/70 focus:outline-none focus:border-white/30 cursor-pointer"
          style={{ background: '#30302e' }}
        >
          <option value="date">Newest first</option>
          <option value="alpha">Alphabetical</option>
          <option value="verified_last">Verified last</option>
        </select>

        <div className="flex-1" />

        {/* Item count */}
        <span className="text-xs text-white/30 shrink-0">
          {loading ? '…' : hasFilters ? `${items.length} matching` : `${items.length} items`}
        </span>
      </div>

      {/* README — standard on database boards (not opt-in like other modes) */}
      <BoardReadme boardId={boardId} initialReadme={initialReadme} onDark />

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 size={20} className="text-white/30 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center text-white/30">
            <Database size={36} className="mb-3 opacity-30" />
            {fetchError
              ? <>
                  <p className="text-sm text-red-400">Search failed</p>
                  <p className="text-xs mt-1 font-mono text-red-300/70 max-w-sm break-all">{fetchError}</p>
                </>
              : hasFilters
              ? <p className="text-sm">No items match the current filters.</p>
              : <>
                  <p className="text-sm">No items yet.</p>
                  <p className="text-xs mt-1">Run the ingestion script to populate the library.</p>
                </>}
          </div>
        ) : (
          <>
            <table className="w-full text-xs border-collapse">
              <thead>
                <TableHead typeFilter={typeFilter} />
              </thead>
              <tbody>
                {items.map(item => (
                  <TableRow
                    key={item.id}
                    item={item}
                    typeFilter={typeFilter}
                    isSelected={selected?.id === item.id}
                    onClick={() => openItem(item)}
                  />
                ))}
              </tbody>
            </table>

            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs text-white/60 hover:text-white border border-white/15 hover:border-white/30 transition-colors disabled:opacity-40"
                >
                  {loadingMore && <Loader2 size={11} className="animate-spin" />}
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <DetailPanel
          item={selected}
          onClose={() => setSelected(null)}
          onUpdated={patch => handleUpdated(selected.id, patch)}
        />
      )}
    </div>
  )
}

// ── Table helpers ──────────────────────────────────────────────────────────────

function TableHead({ typeFilter }: { typeFilter: '' | 'legal_case' | 'paper' }) {
  const th = 'px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-white/30 border-b border-white/8 whitespace-nowrap'

  if (typeFilter === 'legal_case') {
    return (
      <tr style={{ background: '#30302e' }}>
        <th className={`${th} w-8`}></th>
        <th className={th}>Beteckning</th>
        <th className={`${th} w-[35%]`}>Summary</th>
        <th className={th}>Instans</th>
        <th className={th}>Datum</th>
        <th className={`${th} w-6`}></th>
      </tr>
    )
  }
  if (typeFilter === 'paper') {
    return (
      <tr style={{ background: '#30302e' }}>
        <th className={`${th} w-8`}></th>
        <th className={th}>Title</th>
        <th className={`${th} w-[35%]`}>Finding</th>
        <th className={th}>Journal</th>
        <th className={th}>Year</th>
        <th className={`${th} w-6`}></th>
      </tr>
    )
  }
  return (
    <tr style={{ background: '#30302e' }}>
      <th className={`${th} w-8`}></th>
      <th className={th}>Identifier / Title</th>
      <th className={`${th} w-[38%]`}>Summary</th>
      <th className={th}>Source</th>
      <th className={th}>Date</th>
      <th className={`${th} w-6`}></th>
    </tr>
  )
}

function TableRow({
  item,
  typeFilter,
  isSelected,
  onClick,
}: {
  item: LibraryItem
  typeFilter: '' | 'legal_case' | 'paper'
  isSelected: boolean
  onClick: () => void
}) {
  const td = 'px-3 py-2 border-b border-white/6 align-top'
  const rowClass = `cursor-pointer transition-colors ${
    isSelected ? 'bg-[#f4a261]/10' : 'hover:bg-white/5'
  }`

  if (typeFilter === 'legal_case' || (!typeFilter && item.type === 'legal_case')) {
    return (
      <tr className={rowClass} onClick={onClick}>
        <td className={`${td} w-8`}><TypeIcon type={item.type} /></td>
        <td className={td}>
          <span className="font-mono text-white/80">{metaStr(item, 'beteckning') || item.title}</span>
        </td>
        <td className={td}>
          <span className="text-white/60 line-clamp-2">{item.summary}</span>
        </td>
        <td className={`${td} whitespace-nowrap text-white/50`}>{metaStr(item, 'instans')}</td>
        <td className={`${td} whitespace-nowrap text-white/40`}>{metaStr(item, 'datum')}</td>
        <td className={`${td} w-6`}>{item.verified && <CheckCircle2 size={12} className="text-emerald-400" />}</td>
      </tr>
    )
  }

  if (typeFilter === 'paper' || (!typeFilter && item.type === 'paper')) {
    return (
      <tr className={rowClass} onClick={onClick}>
        <td className={`${td} w-8`}><TypeIcon type={item.type} /></td>
        <td className={td}>
          <span className="text-white/80">{item.title}</span>
        </td>
        <td className={td}>
          <span className="text-white/60 line-clamp-2">{item.summary}</span>
        </td>
        <td className={`${td} whitespace-nowrap text-white/50`}>{metaStr(item, 'journal')}</td>
        <td className={`${td} whitespace-nowrap text-white/40`}>{metaStr(item, 'year')}</td>
        <td className={`${td} w-6`}>{item.verified && <CheckCircle2 size={12} className="text-emerald-400" />}</td>
      </tr>
    )
  }

  // Mixed (all types)
  const identifier = item.type === 'legal_case'
    ? (metaStr(item, 'beteckning') || item.title)
    : item.title
  const source = item.type === 'legal_case' ? metaStr(item, 'instans') : metaStr(item, 'journal')
  const date = item.type === 'legal_case' ? metaStr(item, 'datum') : metaStr(item, 'year')

  return (
    <tr className={rowClass} onClick={onClick}>
      <td className={`${td} w-8`}><TypeIcon type={item.type} /></td>
      <td className={td}>
        <span className={`text-white/80 ${item.type === 'legal_case' ? 'font-mono' : ''}`}>{identifier}</span>
      </td>
      <td className={td}>
        <span className="text-white/60 line-clamp-2">{item.summary}</span>
      </td>
      <td className={`${td} whitespace-nowrap text-white/50`}>{source}</td>
      <td className={`${td} whitespace-nowrap text-white/40`}>{date}</td>
      <td className={`${td} w-6`}>{item.verified && <CheckCircle2 size={12} className="text-emerald-400" />}</td>
    </tr>
  )
}
