'use client'

import { useState, useEffect, useRef } from 'react'

interface Props {
  config: Record<string, unknown>
  onPersistConfig: (c: Record<string, unknown>) => void
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

      const qs = new URLSearchParams({ embed: '1' })

      let src = `${SATELLITE}?${qs.toString()}`
      if (session) {
        src += `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token ?? '')}`
      }
      setIframeSrc(src)
    }
    buildSrc()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== SATELLITE) return
      if (e.data?.type === 'text_context') onContextRef.current?.(e.data.context)
      if (e.data?.type === 'text_config')  onPersistRef.current(e.data.config ?? {})
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] overflow-hidden"
      onPointerDown={e => e.stopPropagation()}
    >
      {iframeSrc
        ? <iframe src={iframeSrc} className="w-full h-full border-0" title="Text" />
        : <div className="flex items-center justify-center h-full"><p className="text-white/30 text-xs">Loading…</p></div>
      }
    </div>
  )
}
