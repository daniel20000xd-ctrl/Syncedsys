'use client'

import { useState, useTransition } from 'react'
import { Copy, Check, Link2, X, Eye } from 'lucide-react'
import { linkAccount, acceptLink, removeLink } from '@/app/actions'
import { useRouter } from 'next/navigation'

type Link = {
  id: string
  owner_id: string
  member_id: string
  label: string
  status: string
  created_at: string
}

export default function SettingsClient({
  userId, userEmail, outgoing, incoming,
}: {
  userId: string
  userEmail: string
  outgoing: Link[]
  incoming: Link[]
}) {
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const [memberId, setMemberId] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [isPending, startTransition] = useTransition()

  function copyId() {
    navigator.clipboard.writeText(userId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleLink(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    startTransition(async () => {
      try {
        await linkAccount(memberId.trim(), label)
        setMemberId('')
        setLabel('')
        router.refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to link account')
      }
    })
  }

  function handleAccept(linkId: string) {
    startTransition(async () => {
      await acceptLink(linkId)
      router.refresh()
    })
  }

  function handleRemove(linkId: string) {
    startTransition(async () => {
      await removeLink(linkId)
      router.refresh()
    })
  }

  const pendingIncoming = incoming.filter(l => l.status === 'pending')
  const acceptedIncoming = incoming.filter(l => l.status === 'accepted')

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Settings</h1>

      <div className="space-y-6 max-w-lg">

        {/* Identity */}
        <section className="bg-white rounded-xl p-5 shadow-sm">
          <h2 className="font-semibold text-gray-800 mb-1">Your account</h2>
          <p className="text-sm text-gray-500 mb-3">{userEmail}</p>
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Your account ID — share this with your main account to link</p>
            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <code className="flex-1 text-xs text-gray-700 truncate">{userId}</code>
              <button onClick={copyId} className="text-gray-400 hover:text-gray-700 shrink-0">
                {copied ? <Check size={15} className="text-green-500" /> : <Copy size={15} />}
              </button>
            </div>
          </div>
        </section>

        {/* Link a sub-account */}
        <section className="bg-white rounded-xl p-5 shadow-sm">
          <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
            <Eye size={16} className="text-blue-500" />
            Watch another account
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Paste the account ID of another Syncedsys account. Once accepted, you can see their boards in your overview.
          </p>
          <form onSubmit={handleLink} className="space-y-3">
            <div>
              <label className="text-xs text-gray-600 mb-1 block">Label (e.g. "Work", "School")</label>
              <input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="Work account"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600 mb-1 block">Account ID</label>
              <input
                value={memberId}
                onChange={e => setMemberId(e.target.value)}
                placeholder="Paste UUID here"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <button
              type="submit"
              disabled={isPending || !memberId.trim()}
              className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {isPending ? 'Sending…' : 'Send link request'}
            </button>
          </form>
        </section>

        {/* Outgoing links */}
        {outgoing.length > 0 && (
          <section className="bg-white rounded-xl p-5 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-3">Accounts you're watching</h2>
            <div className="space-y-2">
              {outgoing.map(link => (
                <div key={link.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${link.status === 'accepted' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{link.label}</p>
                    <p className="text-xs text-gray-400 truncate font-mono">{link.member_id.slice(0, 16)}…</p>
                    <p className="text-xs text-gray-400">{link.status === 'accepted' ? 'Active' : 'Waiting for acceptance'}</p>
                  </div>
                  <button
                    onClick={() => handleRemove(link.id)}
                    className="text-gray-300 hover:text-red-400 shrink-0"
                    title="Remove link"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Incoming pending requests */}
        {pendingIncoming.length > 0 && (
          <section className="bg-white rounded-xl p-5 shadow-sm border border-yellow-200">
            <h2 className="font-semibold text-gray-800 mb-1">Pending requests</h2>
            <p className="text-sm text-gray-500 mb-3">Another account wants to view your boards.</p>
            <div className="space-y-2">
              {pendingIncoming.map(link => (
                <div key={link.id} className="flex items-center gap-3 p-3 bg-yellow-50 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{link.label || 'Unknown'}</p>
                    <p className="text-xs text-gray-400 font-mono">{link.owner_id.slice(0, 16)}…</p>
                  </div>
                  <button
                    onClick={() => handleAccept(link.id)}
                    className="bg-green-500 hover:bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleRemove(link.id)}
                    className="text-gray-300 hover:text-red-400"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Accepted incoming */}
        {acceptedIncoming.length > 0 && (
          <section className="bg-white rounded-xl p-5 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-3">Accounts watching you</h2>
            <div className="space-y-2">
              {acceptedIncoming.map(link => (
                <div key={link.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{link.label}</p>
                    <p className="text-xs text-gray-400 font-mono">{link.owner_id.slice(0, 16)}…</p>
                  </div>
                  <button onClick={() => handleRemove(link.id)} className="text-gray-300 hover:text-red-400">
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
