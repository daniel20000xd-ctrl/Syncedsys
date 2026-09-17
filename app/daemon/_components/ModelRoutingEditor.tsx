'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveModelConfig } from '@/app/daemonActions'
import type { ModelKind } from '@/lib/daemon/models'
import { Badge, fmtTime } from './ui'

type Row = {
  call_type: ModelKind
  db_model: string | null
  max_output_tokens: number | null
  note: string | null
  updated_at: string | null
  resolved_model: string | null
  source: 'db' | 'env' | 'none'
}

const btn = 'px-2.5 py-1 rounded border text-xs font-mono disabled:opacity-40'
const input = 'bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs'

function RowEditor({ row }: { row: Row }) {
  const router = useRouter()
  const [model, setModel] = useState(row.db_model ?? row.resolved_model ?? '')
  const [maxTok, setMaxTok] = useState(row.max_output_tokens?.toString() ?? '')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const changed = model.trim() !== (row.db_model ?? '') || (maxTok.trim() || null) !== (row.max_output_tokens?.toString() ?? null)

  const save = () => start(async () => {
    setStatus(null)
    try {
      const tok = maxTok.trim() ? Number(maxTok.trim()) : null
      await saveModelConfig(row.call_type, model.trim(), tok, note)
      setNote('')
      setStatus('saved — takes effect on the next call, no redeploy')
      router.refresh()
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`)
    }
  })

  return (
    <tr className="align-top border-t border-zinc-800">
      <td className="py-2 pr-3 font-mono text-zinc-200 whitespace-nowrap">{row.call_type}</td>
      <td className="pr-3 py-2">
        <input value={model} onChange={e => setModel(e.target.value)} placeholder="model id" className={`${input} w-48`} />
      </td>
      <td className="pr-3 py-2">
        <input value={maxTok} onChange={e => setMaxTok(e.target.value)} placeholder="(default)" className={`${input} w-24`} type="number" min={1} />
      </td>
      <td className="pr-3 py-2">
        {row.source === 'db' ? (
          <Badge tone="green">db row</Badge>
        ) : row.source === 'env' ? (
          <Badge tone="amber">falling back to env{row.resolved_model ? ` (${row.resolved_model})` : ''}</Badge>
        ) : (
          <Badge tone="red">unconfigured — calls will fail</Badge>
        )}
        {row.updated_at && <div className="text-[10px] text-zinc-600 mt-0.5">saved {fmtTime(row.updated_at)}</div>}
        {row.note && <div className="text-[11px] text-zinc-500 mt-0.5">{row.note}</div>}
      </td>
      <td className="py-2">
        <div className="flex items-center gap-2">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (optional)" className={`${input} w-40`} />
          <button className={`${btn} border-emerald-700 text-emerald-300 hover:bg-emerald-950`} disabled={pending || !changed || !model.trim()} onClick={save}>
            save
          </button>
        </div>
        {status && <div className={`text-[11px] mt-1 font-mono ${status.startsWith('error') ? 'text-red-400' : 'text-emerald-400'}`}>{status}</div>}
      </td>
    </tr>
  )
}

export function ModelRoutingEditor({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead className="text-[10px] uppercase tracking-wider text-zinc-500 text-left">
          <tr><th className="font-normal pb-1">call type</th><th className="font-normal">model</th><th className="font-normal">max output tokens</th><th className="font-normal">status</th><th className="font-normal">save</th></tr>
        </thead>
        <tbody>{rows.map(r => <RowEditor key={r.call_type} row={r} />)}</tbody>
      </table>
    </div>
  )
}
