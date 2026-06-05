'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'
import { connectGoogleAccount, disconnectGoogleAccount } from '@/app/actions'

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Identity',
  email: 'Email',
  profile: 'Profile',
  'https://www.googleapis.com/auth/userinfo.email': 'Email',
  'https://www.googleapis.com/auth/userinfo.profile': 'Profile',
  'https://www.googleapis.com/auth/calendar': 'Calendar',
  'https://www.googleapis.com/auth/spreadsheets': 'Sheets',
  'https://www.googleapis.com/auth/documents.readonly': 'Docs (read-only)',
  'https://www.googleapis.com/auth/drive.readonly': 'Drive (read-only)',
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope.replace('https://www.googleapis.com/auth/', '')
}

function GoogleBadge() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 via-red-500 to-yellow-500 text-white text-[10px] font-bold">
      G
    </span>
  )
}

export default function GoogleAccountSettings({
  initialConnected,
  initialScopes,
}: {
  initialConnected: boolean
  initialScopes: string[]
}) {
  const router = useRouter()
  const [connected, setConnected] = useState(initialConnected)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function connect() {
    setError(null)
    startTransition(async () => {
      const res = await connectGoogleAccount()
      if (res.ok && res.url) {
        window.location.href = res.url
      } else {
        setError(res.error ?? 'Could not start Google sign-in.')
      }
    })
  }

  function disconnect() {
    setError(null)
    startTransition(async () => {
      const res = await disconnectGoogleAccount()
      if (res.ok) {
        setConnected(false)
        router.refresh()
      } else {
        setError(res.error ?? 'Could not disconnect.')
      }
    })
  }

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <GoogleBadge />
        Google Account
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Connect your Google account once to power every Google integration —
        Calendar, Sheets, and Docs.
      </p>

      {connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-green-700">
            <Check size={14} className="text-green-600" />
            Connected
          </div>

          {initialScopes.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-1">Authorized access</p>
              <div className="flex flex-wrap gap-1.5">
                {initialScopes.map((s) => (
                  <span key={s} className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
                    {scopeLabel(s)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={disconnect}
            disabled={pending}
            className="text-sm font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
          >
            {pending ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <button
          onClick={connect}
          disabled={pending}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:border-gray-300 disabled:opacity-60"
        >
          <GoogleBadge />
          {pending ? 'Connecting…' : 'Connect Google'}
        </button>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  )
}
