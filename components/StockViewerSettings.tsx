'use client'

import { useState, useTransition } from 'react'
import { BarChart2, ExternalLink, Check } from 'lucide-react'
import { setStocksEnabled } from '@/app/actions'
import { useRouter } from 'next/navigation'

export default function StockViewerSettings({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()

  function toggle(next: boolean) {
    setEnabled(next)
    startTransition(async () => {
      try {
        await setStocksEnabled(next)
        router.refresh()
      } catch {
        setEnabled(!next) // revert on failure
      }
    })
  }

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <BarChart2 size={16} className="text-green-500" />
        Stock Viewer
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Candlestick charts, technical indicators, fundamentals, and news for any stock.
        Supports US tickers (<span className="font-mono text-xs">AAPL</span>,&nbsp;
        <span className="font-mono text-xs">TSLA</span>) and Swedish ones&nbsp;
        (<span className="font-mono text-xs">ERIC-B.ST</span>,&nbsp;
        <span className="font-mono text-xs">VOLV-B.ST</span>).
      </p>

      {/* Toggle row */}
      <label
        className={`flex items-center justify-between gap-4 p-3 rounded-lg border cursor-pointer select-none transition-colors ${
          enabled ? 'border-green-300 bg-green-50' : 'border-gray-200 hover:border-gray-300'
        } ${pending ? 'opacity-60 pointer-events-none' : ''}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {enabled && <Check size={14} className="text-green-600 shrink-0" />}
          <span className="text-sm font-medium text-gray-800">
            {enabled ? 'Stock Viewer is enabled' : 'Enable Stock Viewer'}
          </span>
        </div>

        {/* Toggle switch */}
        <button
          role="switch"
          aria-checked={enabled}
          onClick={() => toggle(!enabled)}
          disabled={pending}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${
            enabled ? 'bg-green-500' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </label>

      {/* Open button — only visible when enabled */}
      {enabled && (
        <button
          onClick={() => router.push('/stocks')}
          className="mt-3 flex items-center gap-1.5 text-sm font-medium text-green-600 hover:text-green-700 transition-colors"
        >
          <ExternalLink size={13} />
          Open Stock Viewer
        </button>
      )}
    </section>
  )
}
