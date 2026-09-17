import Link from 'next/link'
import type { ReactNode } from 'react'
import { getMetricsDashboard } from '@/app/daemonActions'
import { Bar, Empty, ErrorPanel, Json, PageTitle, Panel, Stat, usd } from '../_components/ui'

type Dash = Awaited<ReturnType<typeof getMetricsDashboard>>
type Window = Dash['metrics']['current']

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(0)}%`)
const num = (n: number | null | undefined, unit = '') => (n === null || n === undefined ? '—' : `${n}${unit}`)

function delta(cur: number | null | undefined, prev: number | null | undefined, invert = false): ReactNode {
  if (cur === null || cur === undefined || prev === null || prev === undefined || cur === prev) return <span className="text-zinc-600">±0 vs prior</span>
  const up = cur > prev
  const good = invert ? !up : up
  return <span className={good ? 'text-emerald-400' : 'text-red-400'}>{up ? '▲' : '▼'} from {Math.round(prev * 1000) / 1000}</span>
}

// One column per day; markers show the first real call on a new prompt version.
function Series({ data, markers, field, label, color, format }: {
  data: Dash['series']; markers: Dash['markers']; field: 'cost' | 'calls' | 'errors' | 'pings' | 'replied' | 'replyRate'
  label: string; color: string; format: (n: number) => string
}) {
  const values = data.map(d => (field === 'replyRate' ? (d.pings ? d.replied / d.pings : 0) : d[field]))
  const max = Math.max(...values, field === 'replyRate' ? 1 : 0.0001)
  const markerDates = new Map<string, string[]>()
  for (const m of markers) markerDates.set(m.date, [...(markerDates.get(m.date) ?? []), m.label])
  return (
    <div>
      <div className="flex justify-between text-[11px] text-zinc-500 mb-1"><span>{label}</span><span className="font-mono">max {format(max)}</span></div>
      <div className="flex items-end gap-px h-24 border-b border-zinc-800">
        {data.map((d, i) => {
          const m = markerDates.get(d.date)
          return (
            <div key={d.date} className="relative flex-1 h-full flex items-end" title={`${d.date}: ${format(values[i])}${m ? ` — ${m.join(', ')}` : ''}`}>
              {m && <div className="absolute inset-y-0 left-1/2 w-px bg-fuchsia-500/70" />}
              <div className={`w-full ${color}`} style={{ height: `${(values[i] / max) * 100}%`, minHeight: values[i] ? 1 : 0 }} />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-zinc-600 font-mono mt-0.5"><span>{data[0]?.date}</span><span>{data.at(-1)?.date}</span></div>
    </div>
  )
}

function WindowStats({ cur, prev }: { cur: Window; prev: Window }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="pings sent" value={cur.pings.sent} sub={delta(cur.pings.sent, prev.pings.sent)} />
      <Stat label="reply rate" value={pct(cur.pings.reply_rate)} sub={delta(cur.pings.reply_rate, prev.pings.reply_rate)} />
      <Stat label="time to reply (median / p90)" value={`${num(cur.pings.minutes_to_reply_median, 'm')} / ${num(cur.pings.minutes_to_reply_p90, 'm')}`} sub={delta(cur.pings.minutes_to_reply_median, prev.pings.minutes_to_reply_median, true)} />
      <Stat label="between pings (median / p90)" value={`${num(cur.pings.minutes_between_pings_median, 'm')} / ${num(cur.pings.minutes_between_pings_p90, 'm')}`} />
      <Stat label="longest waking silence" value={cur.pings.longest_waking_silence ? `${cur.pings.longest_waking_silence.minutes}m` : '—'} sub={cur.pings.longest_waking_silence?.date} />
      <Stat label="threads opened (ai / you)" value={`${cur.threads.opened_by_ai} / ${cur.threads.opened_by_user}`} sub={`${cur.threads.with_a_reply} with a reply`} />
      <Stat label="abandonment (ai threads)" value={pct(cur.threads.ai_threads_abandonment_rate)} sub={delta(cur.threads.ai_threads_abandonment_rate, prev.threads.ai_threads_abandonment_rate, true)} />
      <Stat label="expects-reply never answered" value={cur.threads.expects_reply_never_answered} sub={`${cur.threads.closed_stale} closed stale`} />
      <Stat label="heartbeats ok / chose silence" value={`${cur.heartbeats.calls_succeeded} / ${cur.heartbeats.chose_not_to_ping}`} />
      <Stat label="tasks done / archived" value={`${cur.tasks.marked_done} / ${cur.tasks.archived}`} sub={delta(cur.tasks.marked_done, prev.tasks.marked_done)} />
      <Stat label="notes versions / changed lines" value={`${cur.operating_notes.versions_written} / ${cur.operating_notes.changed_lines_total}`} sub={`median ${num(cur.operating_notes.changed_lines_per_version_median)} per version`} />
      <Stat label="cost" value={usd(cur.cost_usd.total)} sub={<>{num(cur.cost_usd.pct_of_daily_cap_avg, '% avg')} · {num(cur.cost_usd.pct_of_daily_cap_max_day, '% max day')}</>} />
    </div>
  )
}

function Buckets({ buckets, order }: { buckets: Record<string, { pings: number; replied: number; reply_rate: number | null }>; order: string[] }) {
  const keys = order.filter(k => buckets[k])
  if (!keys.length) return <Empty>No pings in the window.</Empty>
  const maxPings = Math.max(...keys.map(k => buckets[k].pings))
  return (
    <div className="space-y-1">
      {keys.map(k => (
        <div key={k} className="grid grid-cols-[36px_1fr_1fr] gap-2 items-center">
          <span className="font-mono text-[11px] text-zinc-400">{k}</span>
          <Bar value={buckets[k].pings} max={maxPings} tone="bg-zinc-500" label={`${buckets[k].pings} pings`} />
          <Bar value={buckets[k].reply_rate ?? 0} max={1} tone="bg-emerald-500" label={pct(buckets[k].reply_rate)} />
        </div>
      ))}
    </div>
  )
}

export default async function MetricsPage({ searchParams }: { searchParams: Promise<{ window?: string; days?: string }> }) {
  const params = await searchParams
  const windowDays = [7, 14, 30].includes(Number(params.window)) ? Number(params.window) : 7
  const seriesDays = [14, 30, 60, 90].includes(Number(params.days)) ? Number(params.days) : 30
  let dash: Dash
  try {
    dash = await getMetricsDashboard(windowDays, seriesDays)
  } catch (e) {
    return <ErrorPanel error={e} />
  }
  const { metrics: m, series, markers } = dash
  const cur = m.current
  const hist = Object.entries(m.snapshot.reschedule_histogram).sort((a, b) => Number(a[0]) - Number(b[0]))
  const histMax = Math.max(1, ...hist.map(([, n]) => n))

  return (
    <div className="space-y-4">
      <PageTitle sub="Computed in code from the logs (lib/daemon/metrics.ts) — the same object the weekly meta call receives.">Metrics</PageTitle>
      <div className="flex gap-4 text-xs">
        <span className="text-zinc-600">window:</span>
        {[7, 14, 30].map(w => <Link key={w} href={`/daemon/metrics?window=${w}&days=${seriesDays}`} className={w === windowDays ? 'text-zinc-100 underline' : 'text-zinc-500'}>{w}d</Link>)}
        <span className="text-zinc-600 ml-4">series:</span>
        {[14, 30, 60, 90].map(d => <Link key={d} href={`/daemon/metrics?window=${windowDays}&days=${d}`} className={d === seriesDays ? 'text-zinc-100 underline' : 'text-zinc-500'}>{d}d</Link>)}
      </div>

      <Panel title={`Last ${windowDays} days vs the ${windowDays} before`}>
        <WindowStats cur={cur} prev={m.prior} />
      </Panel>

      <Panel title="Daily series" right={<span><span className="inline-block w-2 h-2 bg-fuchsia-500 mr-1" />prompt version change</span>}>
        <div className="grid gap-5 md:grid-cols-2">
          <Series data={series} markers={markers} field="pings" label="pings / day" color="bg-sky-600" format={n => String(Math.round(n))} />
          <Series data={series} markers={markers} field="replyRate" label="reply rate / day" color="bg-emerald-600" format={n => pct(n)} />
          <Series data={series} markers={markers} field="cost" label="cost / day" color="bg-amber-600" format={n => usd(n)} />
          <Series data={series} markers={markers} field="errors" label="errored call attempts / day" color="bg-red-600" format={n => String(Math.round(n))} />
        </div>
        {markers.length > 0 && (
          <ul className="mt-3 text-[11px] font-mono text-fuchsia-300/80 flex flex-wrap gap-x-4">
            {markers.map((mk, i) => <li key={i}>{mk.date} {mk.label}</li>)}
          </ul>
        )}
        {dash.capUsd !== null && <p className="text-[11px] text-zinc-600 mt-2">daily cap {usd(dash.capUsd, 2)}</p>}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Reply rate by local hour (pings · reply rate)">
          <Buckets buckets={cur.pings.by_local_hour} order={Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))} />
        </Panel>
        <Panel title="Reply rate by weekday">
          <Buckets buckets={cur.pings.by_weekday} order={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']} />
        </Panel>
        <Panel title="Reschedule distribution (active items, now)">
          {hist.length ? (
            <div className="space-y-1">
              {hist.map(([k, n]) => (
                <div key={k} className="grid grid-cols-[60px_1fr] gap-2 items-center">
                  <span className="font-mono text-[11px] text-zinc-400">×{k}</span>
                  <Bar value={n} max={histMax} tone={Number(k) >= 3 ? 'bg-red-500' : 'bg-zinc-500'} label={`${n} items`} />
                </div>
              ))}
              {m.snapshot.most_rescheduled.length > 0 && (
                <ul className="mt-2 text-[12px] text-zinc-400">
                  {m.snapshot.most_rescheduled.map((r, i) => <li key={i}>×{r.reschedule_count} {r.title} <span className="text-zinc-600">({r.status})</span></li>)}
                </ul>
              )}
            </div>
          ) : <Empty>No active items.</Empty>}
        </Panel>
        <Panel title="Cost & errors by call type">
          <table className="w-full text-[12px] font-mono">
            <thead className="text-[10px] text-zinc-500 text-left"><tr><th className="font-normal">call</th><th className="font-normal">cost</th><th className="font-normal">calls</th><th className="font-normal">errors</th><th className="font-normal">retries</th></tr></thead>
            <tbody>
              {[...new Set([...Object.keys(cur.cost_usd.by_call_type), ...Object.keys(cur.errors.by_call_type)])].map(t => (
                <tr key={t}>
                  <td className="text-zinc-300">{t}</td>
                  <td>{usd(cur.cost_usd.by_call_type[t] ?? 0)}</td>
                  <td>{cur.errors.by_call_type[t]?.calls ?? 0}</td>
                  <td className={cur.errors.by_call_type[t]?.errors ? 'text-red-400' : ''}>{cur.errors.by_call_type[t]?.errors ?? 0}</td>
                  <td>{cur.errors.by_call_type[t]?.retries ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-zinc-500 mt-2">warnings: {cur.errors.warnings} · scheduler ticks: {Object.entries(cur.heartbeats.scheduler_ticks).map(([k, v]) => `${k} ${v}`).join(', ') || 'none recorded'}</p>
        </Panel>
      </div>

      <details>
        <summary className="text-xs text-zinc-500 cursor-pointer">raw metrics JSON (as sent to the meta call)</summary>
        <div className="mt-2"><Json value={m} /></div>
      </details>
    </div>
  )
}
