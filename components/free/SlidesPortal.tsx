'use client'

import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, ExternalLink, Play, Plus, FileSliders, Loader2 } from 'lucide-react'

interface Presentation {
  id: string
  title: string
  updated_at: string
}

interface Props {
  config: { presentationId?: string }
  onPersistConfig: (c: { presentationId: string }) => void
  onUpdateContext?: (ctx: string) => void
}

const SATELLITE = 'https://slides.syncedsys.com'

export default function SlidesPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [presentations, setPresentations] = useState<Presentation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [activeTitle, setActiveTitle] = useState<string | undefined>(undefined)

  const onPersistRef = useRef(onPersistConfig)
  const onContextRef = useRef(onUpdateContext)
  useEffect(() => { onPersistRef.current = onPersistConfig }, [onPersistConfig])
  useEffect(() => { onContextRef.current = onUpdateContext }, [onUpdateContext])

  // Build iframe src + fetch context when a presentationId is set
  useEffect(() => {
    if (!config.presentationId) {
      setIframeSrc(null)
      return
    }

    async function buildSrc(id: string) {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()

      let src = `${SATELLITE}/editor/${id}?embed=1`
      if (session) {
        src += `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token ?? '')}`
      }
      setIframeSrc(src)

      if (onContextRef.current && session) {
        fetch(`${SATELLITE}/api/slides/context/${id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` }
        }).then(r => r.text()).then(ctx => onContextRef.current?.(ctx)).catch(() => {})
      }
    }

    buildSrc(config.presentationId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.presentationId])

  // Fetch presentation list when no presentationId
  useEffect(() => {
    if (config.presentationId) return

    async function fetchList() {
      setLoading(true)
      setError(null)
      try {
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) throw new Error('Not authenticated')

        const res = await fetch(`${SATELLITE}/api/slides/presentations`, {
          headers: { Authorization: `Bearer ${session.access_token}` }
        })
        if (!res.ok) throw new Error(`Failed to load presentations (${res.status})`)
        const data = await res.json()
        setPresentations(data)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchList()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.presentationId])

  async function selectPresentation(p: Presentation) {
    setActiveTitle(p.title)
    onPersistRef.current({ presentationId: p.id })
  }

  async function createNew() {
    setCreating(true)
    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const res = await fetch(`${SATELLITE}/api/slides/presentations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title: 'Untitled Presentation' })
      })
      if (!res.ok) throw new Error(`Failed to create (${res.status})`)
      const data = await res.json()
      setActiveTitle(data.title ?? 'Untitled Presentation')
      onPersistRef.current({ presentationId: data.id })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setCreating(false)
    }
  }

  function goBack() {
    setIframeSrc(null)
    setActiveTitle(undefined)
    // Force list refetch by clearing presentationId — parent persists this
    onPersistRef.current({ presentationId: '' as string })
  }

  const presentationId = config.presentationId

  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] overflow-hidden"
      onPointerDown={e => e.stopPropagation()}
    >
      {presentationId && iframeSrc ? (
        <div className="relative w-full h-full flex flex-col">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-2 py-1 bg-[#161920] border-b border-white/10 shrink-0">
            <button
              onClick={goBack}
              className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              title="Back to presentations"
            >
              <ArrowLeft size={14} />
            </button>
            <FileSliders size={13} className="text-white/40 shrink-0" />
            <span className="text-white/70 text-xs truncate flex-1 min-w-0">
              {activeTitle ?? 'Presentation'}
            </span>
            <button
              onClick={() => window.open(`${SATELLITE}/present/${presentationId}`, '_blank')}
              className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              title="Present"
            >
              <Play size={13} />
            </button>
            <button
              onClick={() => window.open(`${SATELLITE}/editor/${presentationId}`, '_blank')}
              className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              title="Open in new tab"
            >
              <ExternalLink size={13} />
            </button>
          </div>
          <iframe src={iframeSrc} className="w-full flex-1 border-0" title="Slides Editor" />
        </div>
      ) : (
        <div className="flex flex-col h-full">
          {/* List header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 shrink-0">
            <span className="text-white/50 text-xs font-medium uppercase tracking-wide">Presentations</span>
            <button
              onClick={createNew}
              disabled={creating}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-colors disabled:opacity-40"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              New
            </button>
          </div>

          {/* List body */}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center h-full">
                <Loader2 size={16} className="animate-spin text-white/30" />
              </div>
            )}
            {error && !loading && (
              <div className="flex items-center justify-center h-full px-4">
                <p className="text-red-400/70 text-xs text-center">{error}</p>
              </div>
            )}
            {!loading && !error && presentations.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
                <FileSliders size={24} />
                <p className="text-xs">No presentations yet</p>
              </div>
            )}
            {!loading && !error && presentations.map(p => (
              <button
                key={p.id}
                onClick={() => selectPresentation(p)}
                className="w-full flex items-start gap-2 px-3 py-2 hover:bg-white/5 transition-colors text-left border-b border-white/5"
              >
                <FileSliders size={13} className="text-white/30 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-white/80 text-xs truncate">{p.title || 'Untitled'}</p>
                  <p className="text-white/30 text-[10px] mt-0.5">
                    {p.updated_at ? new Date(p.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
