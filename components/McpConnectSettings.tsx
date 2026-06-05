'use client'

import { useState, useTransition } from 'react'
import { Plug, Copy, Check, Trash2, Plus } from 'lucide-react'
import { createMcpToken, revokeMcpToken } from '@/app/actions'

type Token = { id: string; name: string; created_at: string; last_used_at: string | null }

export default function McpConnectSettings({ mcpUrl, initialTokens }: { mcpUrl: string; initialTokens: Token[] }) {
  const [tokens, setTokens] = useState<Token[]>(initialTokens)
  const [fresh, setFresh] = useState<string | null>(null) // plaintext, shown once
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const command = (token: string) =>
    `claude mcp add --transport http syncedsys ${mcpUrl} --header "Authorization: Bearer ${token}"`

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1500)
    })
  }

  function generate() {
    setError(null); setFresh(null)
    startTransition(async () => {
      try {
        const res = await createMcpToken()
        if (!res.ok || !res.token || !res.row) { setError(res.error ?? 'Could not create token'); return }
        setFresh(res.token)
        setTokens(t => [res.row!, ...t])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create token')
      }
    })
  }

  function revoke(id: string) {
    if (!confirm('Revoke this token? Any Claude client using it will lose access immediately.')) return
    setTokens(t => t.filter(x => x.id !== id))
    startTransition(async () => {
      try { await revokeMcpToken(id) } catch { /* list refreshes on reload */ }
    })
  }

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <Plug size={16} className="text-emerald-500" /> Connect your own Claude
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Drive your boards from your own Claude — Claude Code, or the Claude desktop/web app — on your
        own subscription. No API key needed. Generate a token, add it to your client, and Claude can
        read and edit everything you own here.
      </p>

      {fresh && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-xs font-medium text-emerald-800 mb-2">
            Copy this now — it&apos;s shown only once.
          </p>
          <div className="flex items-center gap-2 mb-2">
            <code className="flex-1 truncate rounded bg-white border border-emerald-200 px-2 py-1.5 text-xs font-mono text-gray-700">{fresh}</code>
            <button onClick={() => copy(fresh, 'token')} className="shrink-0 text-emerald-700 hover:text-emerald-900 flex items-center gap-1 text-xs">
              {copied === 'token' ? <Check size={13} /> : <Copy size={13} />} Copy
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-1">Add to Claude Code:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-gray-900 px-2 py-1.5 text-xs font-mono text-gray-100">{command(fresh)}</code>
            <button onClick={() => copy(command(fresh), 'cmd')} className="shrink-0 text-gray-600 hover:text-gray-900 flex items-center gap-1 text-xs">
              {copied === 'cmd' ? <Check size={13} /> : <Copy size={13} />} Copy
            </button>
          </div>
        </div>
      )}

      <button
        onClick={generate}
        disabled={pending}
        className="mb-4 inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50"
      >
        <Plus size={15} /> {pending ? 'Generating…' : 'Generate token'}
      </button>
      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      {tokens.length > 0 && (
        <ul className="divide-y divide-gray-100 border-t border-gray-100">
          {tokens.map(t => (
            <li key={t.id} className="flex items-center justify-between py-2.5">
              <div className="min-w-0">
                <span className="block text-sm text-gray-800 truncate">{t.name}</span>
                <span className="block text-xs text-gray-400">
                  {t.last_used_at ? `Last used ${new Date(t.last_used_at).toLocaleDateString()}` : 'Never used'}
                </span>
              </div>
              <button onClick={() => revoke(t.id)} disabled={pending} className="shrink-0 text-xs text-red-600 hover:text-red-700 flex items-center gap-1 disabled:opacity-50">
                <Trash2 size={12} /> Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-gray-400">
        Endpoint: <code className="font-mono">{mcpUrl}</code>. In the Claude desktop/web app, add it as a
        custom connector with the token as a bearer header.
      </p>
    </section>
  )
}
