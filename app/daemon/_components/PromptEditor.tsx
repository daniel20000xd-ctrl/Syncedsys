'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { dryRunPrompt, publishPrompt, revertPrompt, type PromptTab } from '@/app/daemonActions'
import { lineDiff, diffStats } from '@/lib/daemon/diff'

type Version = { version: number; content: string; note: string | null; created_at: string; is_active: boolean; createdLabel: string }
type CallType = 'input' | 'heartbeat' | 'reflection' | 'meta'

export function PromptEditor({ tab, versions, debugAllowed }: { tab: PromptTab; versions: Version[]; debugAllowed: boolean }) {
  const router = useRouter()
  const active = versions.find(v => v.is_active) ?? null
  const [draft, setDraft] = useState(active?.content ?? '')
  const [note, setNote] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [dryType, setDryType] = useState<CallType>(tab === 'system' || tab === 'self_description' ? 'heartbeat' : tab)
  const [dryMessage, setDryMessage] = useState('')
  const [dryResult, setDryResult] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const diff = useMemo(() => lineDiff(active?.content ?? '', draft), [active, draft])
  const stats = diffStats(diff)
  const changed = draft !== (active?.content ?? '')
  const btn = 'px-2.5 py-1 rounded border text-xs font-mono disabled:opacity-40'

  const publish = () => start(async () => {
    try {
      const { version } = await publishPrompt(tab, draft, note)
      setStatus(`published v${version}`)
      setNote('')
      setConfirming(false)
      router.refresh()
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`)
    }
  })

  const revert = (v: number) => {
    const why = window.prompt(`Revert to v${v}? This publishes a copy of v${v} as a new version.\n\nNote (required):`)
    if (!why?.trim()) return
    start(async () => {
      try {
        const { version } = await revertPrompt(tab, v, why)
        setStatus(`reverted: published v${version} (copy of v${v})`)
        router.refresh()
      } catch (e) {
        setStatus(`error: ${(e as Error).message}`)
      }
    })
  }

  const dryRun = () => start(async () => {
    setDryResult(null)
    try {
      const out = await dryRunPrompt({ tab, content: draft, callType: dryType, message: dryMessage })
      setDryResult(JSON.stringify(out, null, 2))
    } catch (e) {
      setDryResult(`error: ${(e as Error).message}`)
    }
  })

  const shown = viewing !== null ? versions.find(v => v.version === viewing) : null
  const callTypeLocked = tab !== 'system'

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3 min-w-0">
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>
            editing from {active ? `active v${active.version}` : 'nothing (no active version)'} · {draft.length} chars
            {changed && <span className="text-amber-300"> · unsaved (+{stats.added} −{stats.removed})</span>}
          </span>
          {changed && <button className="text-zinc-400 hover:text-zinc-200" onClick={() => setDraft(active?.content ?? '')}>discard draft</button>}
        </div>
        <textarea
          value={draft}
          onChange={e => { setDraft(e.target.value); setConfirming(false) }}
          spellCheck={false}
          className="w-full h-[55vh] bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-[12.5px] leading-5 text-zinc-200 focus:outline-none focus:border-zinc-600"
        />

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="why this change (required)"
            className="flex-1 min-w-[240px] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
          />
          <button
            className={`${btn} border-emerald-700 text-emerald-300 hover:bg-emerald-950`}
            disabled={pending || !changed || !draft.trim() || !note.trim()}
            onClick={() => setConfirming(true)}
          >
            review &amp; publish
          </button>
        </div>

        {confirming && (
          <div className="border border-emerald-800 rounded p-3 space-y-2 bg-emerald-950/20">
            <div className="text-xs text-zinc-300">
              Publishing creates v{(versions[0]?.version ?? 0) + 1} and makes it active immediately for every call. Diff against active v{active?.version ?? '—'}:
            </div>
            <DiffBlock lines={diff} />
            <div className="flex gap-2">
              <button className={`${btn} border-emerald-600 text-emerald-200 bg-emerald-950`} disabled={pending} onClick={publish}>confirm publish</button>
              <button className={`${btn} border-zinc-700 text-zinc-400`} onClick={() => setConfirming(false)}>cancel</button>
            </div>
          </div>
        )}
        {status && <p className="text-xs font-mono text-zinc-400">{status}</p>}

        {tab !== 'self_description' && (
          <div className="border border-zinc-800 rounded p-3 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-zinc-400">Dry run the draft</div>
            <p className="text-[11px] text-zinc-500">
              Real context, the draft substituted for the {tab} prompt. Nothing is applied, stored or pushed; the model call is billed and counts toward the cap.
              {!debugAllowed && ' Disabled in production unless DAEMON_DEBUG_ENABLED=true.'}
            </p>
            <div className="flex flex-wrap gap-2 items-center">
              <select
                value={dryType}
                disabled={callTypeLocked}
                onChange={e => setDryType(e.target.value as CallType)}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
              >
                {(['heartbeat', 'input', 'reflection', 'meta'] as const).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {dryType === 'input' && (
                <input
                  value={dryMessage}
                  onChange={e => setDryMessage(e.target.value)}
                  placeholder="sample message from you"
                  className="flex-1 min-w-[200px] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
                />
              )}
              <button
                className={`${btn} border-sky-700 text-sky-300 hover:bg-sky-950`}
                disabled={pending || !debugAllowed || !draft.trim() || (dryType === 'input' && !dryMessage.trim())}
                onClick={dryRun}
              >
                dry run
              </button>
            </div>
            {pending && <p className="text-xs text-zinc-500 font-mono">working…</p>}
            {dryResult && <pre className="text-[11px] font-mono text-zinc-300 bg-zinc-950 border border-zinc-800 rounded p-2 max-h-[50vh] overflow-auto whitespace-pre-wrap">{dryResult}</pre>}
          </div>
        )}
      </div>

      <aside className="space-y-2 min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-zinc-400">History</div>
        {versions.length === 0 && <p className="text-xs text-zinc-600 italic">No versions yet.</p>}
        <ul className="space-y-1.5">
          {versions.map((v, i) => (
            <li key={v.version} className={`border rounded p-2 ${v.is_active ? 'border-emerald-800' : 'border-zinc-800'}`}>
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono text-zinc-200">v{v.version}</span>
                {v.is_active && <span className="text-[10px] font-mono text-emerald-300">active</span>}
                <span className="text-zinc-500 ml-auto">{v.createdLabel}</span>
              </div>
              {v.note && <div className="text-[12px] text-zinc-400 mt-0.5">{v.note}</div>}
              <div className="flex gap-3 mt-1 text-[11px]">
                <button className="text-sky-500" onClick={() => setViewing(viewing === v.version ? null : v.version)}>
                  {viewing === v.version ? 'hide' : i < versions.length - 1 ? 'view diff' : 'view'}
                </button>
                <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setDraft(v.content)}>load into editor</button>
                {!v.is_active && <button className="text-amber-500" disabled={pending} onClick={() => revert(v.version)}>revert to</button>}
              </div>
            </li>
          ))}
        </ul>
        {shown && (
          <div className="border border-zinc-800 rounded p-2 space-y-1">
            <div className="text-[11px] text-zinc-500">v{shown.version} vs previous</div>
            <DiffBlock lines={lineDiff(versions.find(v => v.version < shown.version)?.content ?? '', shown.content)} />
          </div>
        )}
      </aside>
    </div>
  )
}

function DiffBlock({ lines }: { lines: ReturnType<typeof lineDiff> }) {
  if (!lines.some(l => l.op !== 'same')) return <p className="text-xs text-zinc-600 italic">No changes.</p>
  return (
    <div className="font-mono text-[12px] leading-5 border border-zinc-800 rounded max-h-[40vh] overflow-auto">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`px-2 whitespace-pre-wrap ${l.op === 'add' ? 'bg-emerald-950/60 text-emerald-200' : l.op === 'del' ? 'bg-red-950/60 text-red-300' : 'text-zinc-600'}`}
        >
          {l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : '  '}{l.text || ' '}
        </div>
      ))}
    </div>
  )
}
