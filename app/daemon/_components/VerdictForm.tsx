'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { recordVerdict } from '@/app/daemonActions'

const VERDICTS = [
  ['accepted', 'accept', 'border-emerald-700 text-emerald-300 hover:bg-emerald-950'],
  ['rejected', 'reject', 'border-red-700 text-red-300 hover:bg-red-950'],
  ['implemented', 'implemented', 'border-violet-700 text-violet-300 hover:bg-violet-950'],
] as const

export function VerdictForm({ proposalId, current }: { proposalId: string; current: string }) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder={`reason (required)${current !== 'open' ? ` — replaces verdict "${current}"` : ''}`}
        className="flex-1 min-w-[220px] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
      />
      {VERDICTS.map(([verdict, label, cls]) => (
        <button
          key={verdict}
          disabled={pending || !reason.trim()}
          className={`px-2 py-1 rounded border text-xs font-mono disabled:opacity-40 ${cls}`}
          onClick={() => start(async () => {
            setError(null)
            try {
              await recordVerdict(proposalId, verdict, reason)
              setReason('')
              router.refresh()
            } catch (e) {
              setError((e as Error).message)
            }
          })}
        >
          {label}
        </button>
      ))}
      {error && <span className="text-xs text-red-400 font-mono">{error}</span>}
    </div>
  )
}
