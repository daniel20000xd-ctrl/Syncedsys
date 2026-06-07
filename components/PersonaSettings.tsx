'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Trash2, CircleUserRound, AlertTriangle } from 'lucide-react'
import { deletePersona } from '@/app/actions'

type PersonaInfo = { id: string; name: string; color: string; boardCount: number }

export default function PersonaSettings({ personas: initial }: { personas: PersonaInfo[] }) {
  const router = useRouter()
  const [personas, setPersonas] = useState(initial)
  const [pending, setPending] = useState<PersonaInfo | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onlyOne = personas.length <= 1

  function openConfirm(p: PersonaInfo) {
    setPending(p)
    setConfirmText('')
    setError(null)
  }

  async function confirmDelete() {
    if (!pending || confirmText !== pending.name) return
    setDeleting(true)
    setError(null)
    try {
      await deletePersona(pending.id)
      // If this was the remembered active persona, forget it.
      try {
        if (localStorage.getItem('activePersonaId') === pending.id) localStorage.removeItem('activePersonaId')
      } catch {}
      setPersonas(prev => prev.filter(p => p.id !== pending.id))
      setPending(null)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete persona.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1">Personas</h2>
      <p className="text-xs text-gray-500 mb-3">
        Each persona is a separate workspace. Deleting one permanently removes it and every board inside it.
      </p>

      <div className="space-y-1.5">
        {personas.map(p => (
          <div key={p.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-gray-200">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
            <CircleUserRound size={15} className="text-gray-400 shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="text-sm text-gray-800 truncate">{p.name}</span>
              <span className="text-xs text-gray-400 ml-2">{p.boardCount} board{p.boardCount !== 1 ? 's' : ''}</span>
            </span>
            <button
              onClick={() => openConfirm(p)}
              disabled={onlyOne}
              title={onlyOne ? 'You must keep at least one persona' : 'Delete persona'}
              className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded-md text-red-600 hover:bg-red-50 disabled:text-gray-300 disabled:hover:bg-transparent transition-colors"
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        ))}
      </div>

      {onlyOne && (
        <p className="text-[11px] text-gray-400 mt-2">You must keep at least one persona.</p>
      )}

      {pending && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
          onClick={() => !deleting && setPending(null)}
        >
          <div className="bg-white rounded-xl shadow-2xl border border-gray-200 p-5 w-96 mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <div className="shrink-0 w-9 h-9 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle size={17} className="text-red-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">Delete persona &ldquo;{pending.name}&rdquo;?</p>
                <p className="text-xs text-gray-500 mt-1">
                  This permanently deletes the &ldquo;{pending.name}&rdquo; persona and all{' '}
                  <span className="font-semibold text-gray-700">{pending.boardCount} board{pending.boardCount !== 1 ? 's' : ''}</span>{' '}
                  inside it — every tab, sub-tab, and unit. This cannot be undone.
                </p>
              </div>
            </div>

            <label className="block text-xs text-gray-500 mb-1">
              Type <span className="font-semibold text-gray-700">{pending.name}</span> to confirm:
            </label>
            <input
              autoFocus
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && confirmText === pending.name) confirmDelete() }}
              placeholder={pending.name}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-red-500"
            />

            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

            <div className="flex gap-2">
              <button
                onClick={() => setPending(null)}
                disabled={deleting}
                className="flex-1 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting || confirmText !== pending.name}
                className="flex-1 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-40 disabled:hover:bg-red-600"
              >
                {deleting ? 'Deleting…' : 'Delete persona'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </section>
  )
}
