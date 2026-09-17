'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveModelPrice } from '@/app/daemonActions'
import { Badge, fmtTime } from './ui'

type PriceRow = {
  model: string
  input_per_mtok: number | string
  output_per_mtok: number | string
  cached_input_per_mtok: number | string | null
  effective_from: string | null
  note: string | null
  updated_at: string
}

const btn = 'px-2.5 py-1 rounded border text-xs font-mono disabled:opacity-40'
const input = 'bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs'

function Form({ initial, onSaved }: { initial: Partial<PriceRow> & { model?: string }; onSaved: () => void }) {
  const router = useRouter()
  const [model, setModel] = useState(initial.model ?? '')
  const [inPrice, setInPrice] = useState(initial.input_per_mtok?.toString() ?? '')
  const [outPrice, setOutPrice] = useState(initial.output_per_mtok?.toString() ?? '')
  const [cachedPrice, setCachedPrice] = useState(initial.cached_input_per_mtok?.toString() ?? '')
  const [effectiveFrom, setEffectiveFrom] = useState(initial.effective_from ?? '')
  const [note, setNote] = useState(initial.note ?? '')
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const valid = model.trim() && inPrice.trim() !== '' && outPrice.trim() !== '' && !Number.isNaN(Number(inPrice)) && !Number.isNaN(Number(outPrice))

  const save = () => start(async () => {
    setStatus(null)
    try {
      await saveModelPrice({
        model: model.trim(),
        inputPerMtok: Number(inPrice),
        outputPerMtok: Number(outPrice),
        cachedInputPerMtok: cachedPrice.trim() ? Number(cachedPrice) : null,
        effectiveFrom: effectiveFrom.trim() || null,
        note,
      })
      setConfirming(false)
      setStatus('saved')
      router.refresh()
      onSaved()
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`)
    }
  })

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-[10px] text-zinc-500 flex flex-col gap-0.5">model
        <input value={model} onChange={e => { setModel(e.target.value); setConfirming(false) }} placeholder="gemini-3.8-flash" className={`${input} w-44`} disabled={!!initial.model} />
      </label>
      <label className="text-[10px] text-zinc-500 flex flex-col gap-0.5">$/Mtok in
        <input value={inPrice} onChange={e => { setInPrice(e.target.value); setConfirming(false) }} className={`${input} w-20`} type="number" step="0.01" min={0} />
      </label>
      <label className="text-[10px] text-zinc-500 flex flex-col gap-0.5">$/Mtok out
        <input value={outPrice} onChange={e => { setOutPrice(e.target.value); setConfirming(false) }} className={`${input} w-20`} type="number" step="0.01" min={0} />
      </label>
      <label className="text-[10px] text-zinc-500 flex flex-col gap-0.5">$/Mtok cached
        <input value={cachedPrice} onChange={e => { setCachedPrice(e.target.value); setConfirming(false) }} placeholder="—" className={`${input} w-20`} type="number" step="0.01" min={0} />
      </label>
      <label className="text-[10px] text-zinc-500 flex flex-col gap-0.5">effective from
        <input value={effectiveFrom} onChange={e => { setEffectiveFrom(e.target.value); setConfirming(false) }} className={`${input} w-32`} type="date" />
      </label>
      <label className="text-[10px] text-zinc-500 flex flex-col gap-0.5 flex-1 min-w-[160px]">note
        <input value={note} onChange={e => { setNote(e.target.value); setConfirming(false) }} placeholder="e.g. intro rate, doubles 2027-01-01" className={input} />
      </label>
      {!confirming ? (
        <button className={`${btn} border-zinc-700 text-zinc-300 hover:bg-zinc-800`} disabled={!valid} onClick={() => setConfirming(true)}>
          save
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded border border-amber-700 bg-amber-950/40 px-2 py-1">
          <span className="text-[11px] text-amber-300">this changes what the cost cap measures for &ldquo;{model.trim()}&rdquo;</span>
          <button className={`${btn} border-amber-600 text-amber-200 bg-amber-950`} disabled={pending} onClick={save}>confirm</button>
          <button className={`${btn} border-zinc-700 text-zinc-400`} onClick={() => setConfirming(false)}>cancel</button>
        </div>
      )}
      {status && <span className={`text-[11px] font-mono ${status.startsWith('error') ? 'text-red-400' : 'text-emerald-400'}`}>{status}</span>}
    </div>
  )
}

export function ModelPriceEditor({ prices, unpriced }: { prices: PriceRow[]; unpriced: string[] }) {
  const [adding, setAdding] = useState(false)
  return (
    <div className="space-y-3">
      {unpriced.length > 0 && (
        <div className="rounded border border-red-700 bg-red-950/40 p-2 text-[12px] text-red-300">
          <div className="font-medium mb-1">Used in daemon_usage but has no price row — every call on it is recording unknown cost:</div>
          <ul className="space-y-2">
            {unpriced.map(m => (
              <li key={m}>
                <div className="font-mono text-red-200 mb-1">{m}</div>
                <Form initial={{ model: m }} onSaved={() => {}} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="text-[10px] uppercase tracking-wider text-zinc-500 text-left">
            <tr><th className="font-normal pb-1">model</th><th className="font-normal">$/Mtok in</th><th className="font-normal">$/Mtok out</th><th className="font-normal">effective</th><th className="font-normal">note</th><th className="font-normal">updated</th></tr>
          </thead>
          <tbody>
            {prices.map(p => (
              <tr key={p.model} className="align-top border-t border-zinc-800">
                <td colSpan={6} className="py-2">
                  <div className="flex items-center gap-2 mb-1 text-[11px] text-zinc-500">
                    <Badge>{p.model}</Badge>
                    {p.updated_at && <span>updated {fmtTime(p.updated_at)}</span>}
                  </div>
                  <Form
                    initial={{
                      model: p.model, input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok,
                      cached_input_per_mtok: p.cached_input_per_mtok, effective_from: p.effective_from, note: p.note ?? '',
                    }}
                    onSaved={() => {}}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pt-2 border-t border-zinc-800">
        {adding ? (
          <div className="space-y-1">
            <div className="text-[11px] text-zinc-500">add a model not listed above</div>
            <Form initial={{}} onSaved={() => setAdding(false)} />
          </div>
        ) : (
          <button className={`${btn} border-zinc-700 text-zinc-300 hover:bg-zinc-800`} onClick={() => setAdding(true)}>+ add a model</button>
        )}
      </div>
    </div>
  )
}
