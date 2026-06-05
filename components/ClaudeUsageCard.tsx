import { Coins, Check } from 'lucide-react'

function fmtUsd(n: number): string {
  if (n <= 0) return '$0.00'
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

// Shows the user which key their in-app Claude runs on, and — when they're on the
// owner's platform credits — how much they've spent so far.
export default function ClaudeUsageCard({
  hasOwnKey,
  usingPlatform,
  lifetimeUsd,
}: {
  hasOwnKey: boolean
  usingPlatform: boolean
  lifetimeUsd: number
}) {
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
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 mb-3">
            <span className="text-sm text-amber-800">
              Using platform credits — billed by usage. Add your own key below to pay Anthropic directly instead.
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-gray-500">Platform credits used</span>
            <span className="text-lg font-semibold text-gray-800">{fmtUsd(lifetimeUsd)}</span>
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-400 mt-2">Claude isn&rsquo;t configured on this workspace yet.</p>
      )}
    </section>
  )
}
