'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export type GateRequest = {
  id: string
  email: string
  attempt_type: string
  status: string
  created_at: string
  actioned_at: string | null
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function GateRequests({ requests: initial }: { requests: GateRequest[] }) {
  const router = useRouter()
  const [requests, setRequests] = useState(initial)
  const [loading, setLoading] = useState<string | null>(null)

  async function act(id: string, action: 'approve' | 'deny') {
    setLoading(id)
    const prev = requests
    const now = new Date().toISOString()
    setRequests(rs =>
      rs.map(r =>
        r.id === id
          ? { ...r, status: action === 'approve' ? 'approved' : 'denied', actioned_at: now }
          : r
      )
    )
    try {
      const res = await fetch('/api/gate/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      if (!res.ok) throw new Error()
      router.refresh()
    } catch {
      setRequests(prev)
    } finally {
      setLoading(null)
    }
  }

  const pending = requests.filter(r => r.status === 'pending')
  const actioned = requests.filter(r => r.status !== 'pending')

  if (requests.length === 0) {
    return <p className="text-sm text-gray-400 px-5 py-6">No requests yet.</p>
  }

  return (
    <>
      {pending.length > 0 && (
        <div className="divide-y divide-gray-50">
          {pending.map(r => (
            <Row
              key={r.id}
              r={r}
              busy={loading === r.id}
              onApprove={() => act(r.id, 'approve')}
              onDeny={() => act(r.id, 'deny')}
            />
          ))}
        </div>
      )}
      {actioned.length > 0 && (
        <>
          {pending.length > 0 && <div className="border-t border-gray-100" />}
          <div className="divide-y divide-gray-50 opacity-50">
            {actioned.map(r => (
              <Row key={r.id} r={r} busy={false} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function Row({
  r,
  busy,
  onApprove,
  onDeny,
}: {
  r: GateRequest
  busy: boolean
  onApprove?: () => void
  onDeny?: () => void
}) {
  const isPending = r.status === 'pending'
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{r.email}</p>
        <p className="text-xs text-gray-400 mt-0.5">
          {relativeTime(r.created_at)}
          {r.actioned_at ? ` · actioned ${relativeTime(r.actioned_at)}` : ''}
        </p>
      </div>

      <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
        r.attempt_type === 'login'
          ? 'bg-blue-100 text-blue-700'
          : 'bg-purple-100 text-purple-700'
      }`}>
        {r.attempt_type === 'login' ? 'Login' : 'Signup'}
      </span>

      {isPending ? (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onApprove}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {busy ? '…' : 'Approve'}
          </button>
          <button
            onClick={onDeny}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            Deny
          </button>
        </div>
      ) : (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
          r.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
        }`}>
          {r.status}
        </span>
      )}
    </div>
  )
}
