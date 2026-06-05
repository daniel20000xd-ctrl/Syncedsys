'use client'

import { useState, useTransition } from 'react'
import { Coins, Check } from 'lucide-react'
import { setClaudePayPerUse } from '@/app/actions'

function fmtUsd(n: number): string {
  if (n <= 0) return '$0.00'
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

// Shows the user which key their in-app Claude runs on and, when they're on the
// owner's platform credits, their free-tier usage this month + a pay-per-use opt-in.
export default function ClaudeUsageCard({
  hasOwnKey,
  usingPlatform,
  initialPayPerUse,
  freeUsd,
  spentUsd,
  owedUsd,
}: {
  hasOwnKey: boolean
  usingPlatform: boolean
  initialPayPerUse: boolean
  freeUsd: number
  spentUsd: number
  owedUsd: number
}) {
  const [payPerUse, setPayPerUse] = useState(initialPayPerUse)
  const [pending, startTransition] = useTransition()

  function toggle(next: boolean) {
    setPayPerUse(next)
    startTransition(async () => {
      const res = await setClaudePayPerUse(next)
      if (!res.ok) setPayPerUse(!next)
    })
  }

  const pct = freeUsd > 0 ? Math.min(100, (spentUsd / freeUsd) * 100) : 100
  const overFree = spentUsd >= freeUsd
  const barColor = overFree ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-green-500'

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <Coins size={16} className="text-fuchsia-500" /> Claude usage
      </h2>

      {hasOwnKey ? (
        <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mt-2">
          <Check size={14} className="text-green-700 shrink-0" />
          <span className="text-sm text-green-700">Running on your own API key — no platform charges.</span>
        </div>
      ) : usingPlatform ? (
        <>
          <p className="text-sm text-gray-500 mb-3">
            {fmtUsd(spentUsd)} of {fmtUsd(freeUsd)} free used this month
          </p>
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mb-4">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct.toFixed(2)}%` }} />
          </div>

          {overFree && !payPerUse && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              <span className="text-sm text-amber-800">
                Free credit for this month is used up. Claude is paused for you until it resets — turn on
                pay-per-use to keep going, or add your own API key below.
              </span>
            </div>
          )}

          {payPerUse && owedUsd > 0 && (
            <div className="flex items-baseline justify-between mb-3">
              <span className="text-sm text-gray-500">Owed this month (after free tier)</span>
              <span className="text-lg font-semibold text-gray-800">{fmtUsd(owedUsd)}</span>
            </div>
          )}

          <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${payPerUse ? 'border-fuchsia-300 bg-fuchsia-50' : 'border-gray-200'} ${pending ? 'opacity-60' : ''}`}>
            <input type="checkbox" checked={payPerUse} onChange={e => toggle(e.target.checked)} disabled={pending} className="mt-0.5" />
            <span>
              <span className="block text-sm font-medium text-gray-800">Pay for usage beyond the free tier</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                When off, Claude pauses once your free monthly credit runs out — you&rsquo;re never charged. When on,
                it keeps working and you pay for usage above {fmtUsd(freeUsd)}.
              </span>
            </span>
          </label>
        </>
      ) : (
        <p className="text-sm text-gray-400 mt-2">Claude isn&rsquo;t configured on this workspace yet.</p>
      )}
    </section>
  )
}
