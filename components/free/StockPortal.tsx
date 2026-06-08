'use client'

import { useState, useEffect, useRef } from 'react'

interface Props {
  config: { ticker?: string; interval?: string }
  onPersistConfig: (c: { ticker: string; interval: string }) => void
  onUpdateContext?: (ctx: string) => void
}

const SATELLITE = 'https://stocks.syncedsys.com'

export default function StockPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const iframeRef      = useRef<HTMLIFrameElement>(null)
  const onPersistRef   = useRef(onPersistConfig)
  const onContextRef   = useRef(onUpdateContext)
  // Track the ticker the iframe was last LOADED with so we can detect external
  // config changes (e.g. another device / future tooling) without reloading when
  // the change came from within the iframe itself.
  const loadedTickerRef = useRef<string | undefined>(undefined)
  useEffect(() => { onPersistRef.current  = onPersistConfig }, [onPersistConfig])
  useEffect(() => { onContextRef.current  = onUpdateContext  }, [onUpdateContext])

  // Build / rebuild the iframe URL. Runs on mount and whenever config.ticker
  // changes to a value that differs from what the iframe is already showing.
  // When the user searches inside the iframe the message handler updates
  // loadedTickerRef first, so the subsequent config prop change is a no-op here.
  useEffect(() => {
    if (config.ticker !== undefined && config.ticker === loadedTickerRef.current) return
    async function buildSrc() {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()

      const qs = new URLSearchParams({ embed: '1' })
      if (config.ticker)   qs.set('ticker',   config.ticker)
      if (config.interval) qs.set('interval', config.interval)

      let src = `${SATELLITE}?${qs.toString()}`
      if (session) {
        src += `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token ?? '')}`
      }
      loadedTickerRef.current = config.ticker
      setIframeSrc(src)
    }
    buildSrc()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.ticker])

  // Listen for postMessage from THIS portal's own iframe. All portals share the
  // parent window, so without the e.source check every portal would react to every
  // other portal's messages — overwriting each portal's saved ticker/context with
  // whichever stock was last opened anywhere on the board.
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== SATELLITE) return
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data?.type === 'stock_context') onContextRef.current?.(e.data.context)
      if (e.data?.type === 'stock_config') {
        // Mark the new ticker as "already loaded" so the buildSrc effect won't
        // reload the iframe when the config prop updates to match.
        loadedTickerRef.current = e.data.ticker
        onPersistRef.current({ ticker: e.data.ticker, interval: e.data.interval })
      }
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
        ? <iframe ref={iframeRef} src={iframeSrc} className="w-full h-full border-0" title="Stock Viewer" />
        : <div className="flex items-center justify-center h-full"><p className="text-white/30 text-xs">Loading…</p></div>
      }
    </div>
  )
}
