import Link from 'next/link'
import { getArchiveMonth, getDayEntries } from '@/app/daemonActions'
import { localDate } from '@/lib/daemon/time'
import type { Family } from '@/lib/daemon/files'
import { Badge, callTone, Empty, ErrorPanel, fmtTime, Md, PageTitle, Panel } from '../_components/ui'

const FAMILIES: Family[] = ['daylog', 'reflections', 'calendar']

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ date?: string; month?: string; family?: string }> }) {
  const params = await searchParams
  const today = localDate()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : today.slice(0, 7)
  const family = FAMILIES.includes(params.family as Family) ? (params.family as Family) : 'reflections'

  let day: Awaited<ReturnType<typeof getDayEntries>>
  let files: Awaited<ReturnType<typeof getArchiveMonth>>
  try {
    ;[day, files] = await Promise.all([getDayEntries(date), getArchiveMonth(family, month)])
  } catch (e) {
    return <ErrorPanel error={e} />
  }

  const blocks = files.locations
    .flatMap(l => l.blocks.map(b => ({ ...b, key: l.key })))
    .sort((a, b) => b.date.localeCompare(a.date))
  const dupDates = new Set(blocks.map(b => b.date).filter((d, i, arr) => arr.indexOf(d) !== i))
  const href = (p: Record<string, string>) => `/daemon/logs?${new URLSearchParams({ date, month, family, ...p })}`
  const input = 'bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs'

  return (
    <div>
      <PageTitle sub="Read-only. The right pane reads R2 directly, including grouped year folders — it doubles as the check that rotation is lossless.">Logs</PageTitle>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title={`Day entries — ${date}`}
          right={
            <form action="/daemon/logs" className="flex gap-1">
              <input type="hidden" name="month" value={month} />
              <input type="hidden" name="family" value={family} />
              <input type="date" name="date" defaultValue={date} className={input} />
              <button className="px-2 rounded border border-zinc-700 text-xs">go</button>
            </form>
          }
        >
          {day.entries.length ? (
            <ol className="space-y-1.5">
              {day.entries.map(e => (
                <li key={e.id} className="flex gap-2 text-[13px]">
                  <span className="font-mono text-zinc-500 shrink-0">{fmtTime(e.created_at, false)}</span>
                  <Badge tone={callTone(e.call_type)}>{e.call_type}</Badge>
                  <span className="text-zinc-300 flex-1">{e.content}</span>
                  {e.thread_id && <Link href={`/daemon/threads?id=${e.thread_id}`} className="text-[11px] text-sky-500 shrink-0">thread</Link>}
                </li>
              ))}
            </ol>
          ) : <Empty>No entries for {date}.</Empty>}
          {day.knownDates.length > 0 && (
            <div className="mt-3 pt-2 border-t border-zinc-800 flex flex-wrap gap-x-2 gap-y-1 text-[11px] font-mono">
              {day.knownDates.map(d => <Link key={d} href={href({ date: d })} className={d === date ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}>{d}</Link>)}
            </div>
          )}
        </Panel>

        <Panel
          title={`${family} — ${month}`}
          right={
            <form action="/daemon/logs" className="flex gap-1">
              <input type="hidden" name="date" value={date} />
              <select name="family" defaultValue={family} className={input}>{FAMILIES.map(f => <option key={f}>{f}</option>)}</select>
              <input type="month" name="month" defaultValue={month} className={input} />
              <button className="px-2 rounded border border-zinc-700 text-xs">go</button>
            </form>
          }
        >
          <div className="mb-3 text-[11px] font-mono text-zinc-500 space-y-0.5">
            {files.locations.length ? files.locations.map(l => (
              <div key={l.key}>{l.key.split('/daemon/')[1]} · {l.blocks.length} block{l.blocks.length === 1 ? '' : 's'} for {month}{l.preamble ? ' · has preamble' : ''}</div>
            )) : <div>no file holds {month}</div>}
            {dupDates.size > 0 && <div className="text-amber-300">same date in more than one block/location: {[...dupDates].join(', ')} (check rotation)</div>}
          </div>
          {blocks.length ? (
            <div className="space-y-3">
              {blocks.map((b, i) => (
                <article key={`${b.key}${b.date}${i}`} className="border-t border-zinc-800 pt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-zinc-200">{b.date}</span>
                    <span className="text-[10px] font-mono text-zinc-600">{b.key.split('/daemon/')[1]}</span>
                  </div>
                  <Md>{b.body}</Md>
                </article>
              ))}
            </div>
          ) : <Empty>No blocks for {month}.</Empty>}

          <details className="mt-4">
            <summary className="text-[11px] text-zinc-500 cursor-pointer">all {family} files in R2 ({files.files.length})</summary>
            <ul className="mt-1 text-[11px] font-mono text-zinc-500">
              {files.files.map(f => {
                const m = f.relative.match(/(\d{4}-\d{2})\.md$/)
                return (
                  <li key={f.key}>
                    {m ? <Link href={href({ month: m[1] })} className="text-sky-600 hover:underline">{f.relative}</Link> : f.relative}
                    {' '}· {f.size}B · {fmtTime(f.lastModified)}
                  </li>
                )
              })}
            </ul>
          </details>
        </Panel>
      </div>
    </div>
  )
}
