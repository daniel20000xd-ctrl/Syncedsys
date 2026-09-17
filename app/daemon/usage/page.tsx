import { getUsage } from '@/app/daemonActions'
import { Badge, Bar, callTone, Empty, ErrorPanel, fmtTime, PageTitle, Panel, usd } from '../_components/ui'

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ type?: string; from?: string; to?: string; errors?: string }> }) {
  const params = await searchParams
  let data: Awaited<ReturnType<typeof getUsage>>
  try {
    data = await getUsage({ callType: params.type || undefined, from: params.from, to: params.to, errorsOnly: params.errors === '1' })
  } catch (e) {
    return <ErrorPanel error={e} />
  }
  const days = Object.entries(data.daily).sort((a, b) => b[0].localeCompare(a[0]))
  const input = 'bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs'

  return (
    <div className="space-y-4">
      <PageTitle sub="daemon_usage, newest first. Warning rows (model n/a) carry code-side warnings. Defaults to the last 7 days.">Usage ledger</PageTitle>
      <form action="/daemon/usage" className="flex flex-wrap gap-2 items-center">
        <select name="type" defaultValue={params.type ?? ''} className={input}>
          <option value="">all call types</option>
          {['input', 'heartbeat', 'reflection', 'meta'].map(t => <option key={t}>{t}</option>)}
        </select>
        <input type="date" name="from" defaultValue={params.from} className={input} />
        <span className="text-zinc-600 text-xs">to</span>
        <input type="date" name="to" defaultValue={params.to} className={input} />
        <label className="text-xs text-zinc-400 flex items-center gap-1"><input type="checkbox" name="errors" value="1" defaultChecked={params.errors === '1'} /> errors only</label>
        <button className="px-2.5 py-1 rounded border border-zinc-700 text-xs">filter</button>
      </form>

      <Panel title="Daily totals vs cap" right={data.capUsd === null ? 'no cap set' : `cap ${usd(data.capUsd, 2)}`}>
        {days.length ? (
          <div className="space-y-1">
            {days.map(([d, t]) => (
              <div key={d} className="grid grid-cols-[90px_1fr_150px] gap-2 items-center text-[12px] font-mono">
                <span className="text-zinc-400">{d}</span>
                <Bar value={t.cost} max={data.capUsd ?? Math.max(...days.map(x => x[1].cost), 0.0001)} tone={data.capUsd && t.cost >= data.capUsd ? 'bg-red-500' : 'bg-amber-500'} label={usd(t.cost)} />
                <span className="text-zinc-500">
                  {t.calls} calls{t.errors ? <span className="text-red-400"> · {t.errors} err</span> : ''}
                  {t.unknownCost ? <span className="text-red-400"> · {t.unknownCost} unpriced</span> : ''}
                </span>
              </div>
            ))}
          </div>
        ) : <Empty>No usage in range.</Empty>}
        {params.type && <p className="text-[11px] text-amber-300 mt-2">Totals are filtered to {params.type}; the cap applies to all call types combined.</p>}
      </Panel>

      <Panel title="Rows" right={`${data.rows.length}${data.truncated ? ' (truncated at 1000)' : ''}`}>
        {data.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] font-mono">
              <thead className="text-[10px] text-zinc-500 text-left">
                <tr>{['time', 'call', 'model', 'prompt v', 'in', 'out', 'cost', 'try', 'error / note'].map(h => <th key={h} className="font-normal pb-1 pr-3 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {data.rows.map(r => (
                  <tr key={r.id} className={`align-top ${r.error ? 'bg-red-950/20' : ''}`}>
                    <td className="pr-3 py-1 whitespace-nowrap text-zinc-400">{fmtTime(r.created_at)}</td>
                    <td className="pr-3"><Badge tone={callTone(r.call_type)}>{r.call_type}</Badge>{r.dry_run && <> <Badge tone="violet">dry run</Badge></>}</td>
                    <td className="pr-3 text-zinc-500 whitespace-nowrap">{r.model}</td>
                    <td className="pr-3 text-zinc-400 whitespace-nowrap">{r.system_prompt_version ?? '—'}/{r.call_prompt_version ?? '—'}</td>
                    <td className="pr-3 text-right">{r.input_tokens}</td>
                    <td className="pr-3 text-right">{r.output_tokens}</td>
                    <td className="pr-3 text-right">{r.cost_usd === null ? <span className="text-red-400">unknown</span> : usd(r.cost_usd, 5)}</td>
                    <td className={`pr-3 text-right ${r.attempt > 1 ? 'text-amber-300' : ''}`}>{r.attempt}</td>
                    <td className="text-zinc-400 max-w-xl break-words">
                      {r.error && <span className={r.model === 'n/a' ? 'text-amber-300' : 'text-red-400'}>{r.error}</span>}
                      {r.note && <span className="text-zinc-500">{r.error ? ' · ' : ''}{r.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No rows.</Empty>}
      </Panel>
    </div>
  )
}
