'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { forceReleaseLock, setEnabled, setShadowMode, triggerCall } from '@/app/daemonActions'

type Props = {
  shadowMode: boolean
  enabled: boolean
  lock: { held: boolean; holder: string | null; ageSeconds: number | null; timeoutSeconds: number; stale: boolean }
  debugAllowed: boolean
}

export function OperatorControls({ shadowMode, enabled, lock, debugAllowed }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [result, setResult] = useState<string | null>(null)

  const run = (fn: () => Promise<unknown>) => start(async () => {
    setResult(null)
    try {
      const out = await fn()
      if (out !== undefined) setResult(JSON.stringify(out, null, 2))
    } catch (e) {
      setResult(`error: ${(e as Error).message}`)
    }
    router.refresh()
  })

  const btn = 'px-2.5 py-1 rounded border text-xs font-mono disabled:opacity-40'

  return (
    <div className="space-y-3">
      <div className={`rounded border p-2.5 ${shadowMode ? 'border-sky-800 bg-sky-950/40' : 'border-red-700 bg-red-950/50'}`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">Shadow mode</div>
            <div className={`font-mono text-base font-bold ${shadowMode ? 'text-sky-300' : 'text-red-300'}`}>
              {shadowMode ? 'ON — no pushes' : 'OFF — LIVE TO PHONE'}
            </div>
          </div>
          <button
            disabled={pending}
            className={`${btn} ${shadowMode ? 'border-red-700 text-red-300 hover:bg-red-950' : 'border-sky-700 text-sky-300 hover:bg-sky-950'}`}
            onClick={() => {
              const msg = shadowMode
                ? 'Turn shadow mode OFF? The daemon will start pushing messages to your phone.'
                : 'Turn shadow mode ON? Messages will be logged but not pushed.'
              if (window.confirm(msg)) run(() => setShadowMode(!shadowMode))
            }}
          >
            turn {shadowMode ? 'off' : 'on'}
          </button>
        </div>
      </div>

      <div className={`rounded border p-2.5 ${enabled ? 'border-zinc-800' : 'border-red-700 bg-red-950/50'}`}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-400">Kill switch</div>
            <div className={`font-mono text-base font-bold ${enabled ? 'text-emerald-300' : 'text-red-300'}`}>{enabled ? 'ENABLED' : 'DISABLED'}</div>
          </div>
          <button
            disabled={pending}
            className={`${btn} ${enabled ? 'border-red-700 text-red-300 hover:bg-red-950' : 'border-emerald-700 text-emerald-300 hover:bg-emerald-950'}`}
            onClick={() => {
              const msg = enabled
                ? 'DISABLE the daemon? This stops everything: heartbeats, reflection, the weekly review, queued-message answers and dry runs. Messages you send are still saved.'
                : 'Re-enable the daemon?'
              if (window.confirm(msg)) run(() => setEnabled(!enabled))
            }}
          >
            {enabled ? 'disable' : 'enable'}
          </button>
        </div>
      </div>

      <div className="rounded border border-zinc-800 p-2.5">
        <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1.5">Run now</div>
        {!debugAllowed && <p className="text-[11px] text-zinc-500 mb-1.5">Disabled in production unless DAEMON_DEBUG_ENABLED=true.</p>}
        <div className="flex gap-2">
          {(['heartbeat', 'reflection', 'meta'] as const).map(type => (
            <button
              key={type}
              disabled={pending || !debugAllowed}
              className={`${btn} border-zinc-700 text-zinc-300 hover:bg-zinc-800`}
              onClick={() => {
                const warn = shadowMode ? '' : '\n\nShadow mode is OFF: this may push to your phone.'
                if (window.confirm(`Run ${type} now? It bypasses quiet hours and the schedule, and costs a model call.${warn}`)) run(() => triggerCall(type))
              }}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {lock.held && lock.stale && (
        <div className="rounded border border-amber-700 bg-amber-950/40 p-2.5">
          <div className="text-[11px] text-amber-300 mb-1.5">
            Lock held by <b>{lock.holder}</b> for {lock.ageSeconds}s (stale after {lock.timeoutSeconds}s).
          </div>
          <button
            disabled={pending}
            className={`${btn} border-amber-700 text-amber-300 hover:bg-amber-950`}
            onClick={() => { if (window.confirm(`Force-release the ${lock.holder} lock?`)) run(() => forceReleaseLock()) }}
          >
            force-release lock
          </button>
        </div>
      )}

      {pending && <p className="text-xs text-zinc-500 font-mono">working…</p>}
      {result && <pre className="text-[11px] font-mono text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">{result}</pre>}
    </div>
  )
}
