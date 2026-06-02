'use client'

import { useState, useTransition } from 'react'
import { Sparkles, Check, Trash2, Eye, EyeOff } from 'lucide-react'
import { saveAnthropicKey, removeAnthropicKey, setClaudeAutoApply } from '@/app/actions'

export default function ClaudeKeySettings({ initialHasKey, initialAutoApply }: { initialHasKey: boolean; initialAutoApply: boolean }) {
  const [hasKey, setHasKey] = useState(initialHasKey)
  const [autoApply, setAutoApply] = useState(initialAutoApply)
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  function save() {
    setError(null); setSaved(false)
    startTransition(async () => {
      try {
        const res = await saveAnthropicKey(key)
        if (!res.ok) { setError(res.error ?? 'Could not save key'); return }
        setHasKey(true); setKey(''); setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save key')
      }
    })
  }

  function remove() {
    if (!confirm('Disconnect Claude? Your stored key will be deleted.')) return
    startTransition(async () => {
      try { await removeAnthropicKey(); setHasKey(false) } catch {}
    })
  }

  function toggleWrites(next: boolean) {
    setAutoApply(next)
    startTransition(async () => {
      try { await setClaudeAutoApply(next) } catch { setAutoApply(!next) }
    })
  }

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <Sparkles size={16} className="text-fuchsia-500" /> Claude
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Connect your own Anthropic API key to use Claude inside your boards. Your key is encrypted and never shared.
        Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">console.anthropic.com</a>.
      </p>

      {hasKey ? (
        <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-4">
          <span className="text-sm text-green-700 flex items-center gap-1.5"><Check size={14} /> Claude is connected</span>
          <button onClick={remove} disabled={pending} className="text-xs text-red-600 hover:text-red-700 flex items-center gap-1 disabled:opacity-50">
            <Trash2 size={12} /> Disconnect
          </button>
        </div>
      ) : (
        <div className="mb-4">
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="sk-ant-..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:border-blue-500"
            />
            <button onClick={() => setShow(s => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
          {saved && <p className="text-xs text-green-600 mt-1.5">Saved.</p>}
          <button
            onClick={save}
            disabled={pending || !key.trim()}
            className="mt-2 bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Connect Claude'}
          </button>
        </div>
      )}

      {/* Writes toggle */}
      <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${autoApply ? 'border-fuchsia-300 bg-fuchsia-50' : 'border-gray-200'} ${!hasKey ? 'opacity-50 pointer-events-none' : ''}`}>
        <input type="checkbox" checked={autoApply} onChange={e => toggleWrites(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="block text-sm font-medium text-gray-800">Let Claude make changes</span>
          <span className="block text-xs text-gray-500 mt-0.5">
            When on, Claude can create and edit tabs, lists, cards, notes and files — but only within the tab it lives in and the tabs reachable below it. When off, Claude is read-only.
          </span>
        </span>
      </label>
    </section>
  )
}
