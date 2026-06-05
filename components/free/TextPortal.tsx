'use client'

import { useState, useEffect, useRef } from 'react'

interface Props {
  config: { boardId?: string }
  onPersistConfig: (c: { boardId?: string }) => void
  onUpdateContext?: (ctx: string) => void
}

const SATELLITE = 'https://text.syncedsys.com'

export default function TextPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const onPersistRef = useRef(onPersistConfig)
  const onContextRef = useRef(onUpdateContext)
  useEffect(() => { onPersistRef.current = onPersistConfig }, [onPersistConfig])
  useEffect(() => { onContextRef.current = onUpdateContext }, [onUpdateContext])

  useEffect(() => {
    async function buildSrc() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      let boardId = config.boardId

      if (!boardId) {
        const { data } = await supabase
          .from('boards')
          .insert({ name: 'Untitled', mode: 'text', user_id: session.user.id, color: '#0079bf', tab_position: 0 })
          .select('id')
          .single()
        if (!data?.id) return
        boardId = data.id
        onPersistRef.current({ boardId })
      }

      setIframeSrc(`${SATELLITE}/board/${boardId}?embed=true&token=${encodeURIComponent(session.access_token)}`)
    }
    buildSrc()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== SATELLITE) return
      if (e.data?.type === 'text_context') onContextRef.current?.(e.data.context)
      if (e.data?.type === 'text_config')  onPersistRef.current({ boardId: config.boardId, ...e.data.config })
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [config.boardId])

  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#1a1a1a] overflow-hidden"
      onPointerDown={e => e.stopPropagation()}
    >
      {iframeSrc
        ? <iframe src={iframeSrc} className="w-full h-full border-0" title="Text" />
        : <div className="flex items-center justify-center h-full"><p className="text-white/30 text-xs">Loading…</p></div>
      }
    </div>
  )
}
