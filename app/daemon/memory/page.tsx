import Link from 'next/link'
import { getMemory, type MemoryFilters } from '@/app/daemonActions'
import { Badge, Empty, ErrorPanel, fmtAgo, fmtTime, PageTitle, Panel, type Tone } from '../_components/ui'

type Data = Awaited<ReturnType<typeof getMemory>>
type Search = MemoryFilters

const statusTone = (s: string): Tone => (s === 'done' ? 'green' : s === 'blocked' ? 'red' : s === 'in_progress' ? 'blue' : 'zinc')
const eventTone = (e: string): Tone => (e === 'archived' ? 'zinc' : e === 'promoted' ? 'amber' : 'green')

function Links({ stubs }: { stubs: Data['stubs'][string] | undefined }) {
  if (!stubs?.length) return null
  return (
    <ul className="mt-1 space-y-0.5">
      {stubs.map(s => (
        <li key={`${s.kind}${s.id}`} className="text-[11px] text-zinc-500">
          ↔ <Link href={`/daemon/memory?item=${s.id}`} className="text-sky-500 hover:underline">{s.title}</Link>{' '}
          <span className="text-zinc-600">[{s.kind}]</span> — {s.why}
        </li>
      ))}
    </ul>
  )
}

function Journey({ events }: { events: Data['events'][string] | undefined }) {
  if (!events?.length) return null
  return (
    <ol className="mt-1.5 border-l border-zinc-800 pl-2 space-y-0.5">
      {events.map((e, i) => (
        <li key={i} className="text-[11px] text-zinc-500">
          <span className="font-mono text-zinc-600">{fmtTime(e.created_at)}</span> <Badge tone={eventTone(e.event)}>{e.event}</Badge>
          {e.call_type && <span className="text-zinc-600"> by {e.call_type}</span>}
          {e.why && <span> — {e.why}</span>}
          {e.outcome && <span className="text-zinc-400"> (outcome: {e.outcome})</span>}
        </li>
      ))}
    </ol>
  )
}

export default async function MemoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams
  const filters: MemoryFilters = { q: params.q, tag: params.tag, type: params.type, status: params.status, item: params.item }
  let data: Data
  try {
    data = await getMemory(filters)
  } catch (e) {
    return <ErrorPanel error={e} />
  }

  const item = params.item
  const { active, archive } = data
  const lineageOf = (a: { id: string; original_id: string | null }) => a.original_id ?? a.id
  const input = 'bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs'

  return (
    <div>
      <PageTitle sub="Read-only by design: change the daemon's memory by messaging it, never by editing rows.">Memory</PageTitle>

      <form className="flex flex-wrap gap-2 mb-4" action="/daemon/memory">
        <input name="q" defaultValue={params.q} placeholder="search title/content" className={`${input} w-56`} />
        <select name="tag" defaultValue={params.tag ?? ''} className={input}>
          <option value="">any tag</option>
          {data.tags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select name="type" defaultValue={params.type ?? ''} className={input}>
          <option value="">any type</option>
          {['task', 'problem', 'note'].map(t => <option key={t}>{t}</option>)}
        </select>
        <select name="status" defaultValue={params.status ?? ''} className={input}>
          <option value="">any status (status hides archive)</option>
          {['open', 'in_progress', 'blocked', 'done'].map(t => <option key={t}>{t}</option>)}
        </select>
        <button className="px-2.5 py-1 rounded border border-zinc-700 text-xs">filter</button>
        {(params.q || params.tag || params.type || params.status || item) && <Link href="/daemon/memory" className="text-xs text-zinc-500 self-center">clear</Link>}
      </form>
      {item && <p className="text-xs text-amber-300 mb-3">Showing one item&apos;s lineage. <Link href="/daemon/memory" className="text-sky-500">show all</Link></p>}

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Active — in mind now" right={`${active.length}${data.active.length === 300 ? '+' : ''}`}>
          {active.length ? (
            <ul className="divide-y divide-zinc-800/70">
              {active.map(a => (
                <li key={a.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/daemon/memory?item=${a.id}`} className="text-zinc-100 font-medium hover:underline">{a.title}</Link>
                    <Badge>{a.type}</Badge>
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                    {a.reschedule_count > 0 && <Badge tone={a.reschedule_count >= 3 ? 'red' : 'amber'}>rescheduled ×{a.reschedule_count}</Badge>}
                    {a.awaiting_report_since && <Badge tone="amber">awaiting report {fmtAgo(a.awaiting_report_since)}</Badge>}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 font-mono">
                    deadline {fmtTime(a.deadline)} · nudged {fmtAgo(a.last_nudged_at)} · touched {fmtAgo(a.last_touched)}
                    {a.tags.length > 0 && <> · {a.tags.map(t => <Link key={t} href={`/daemon/memory?tag=${encodeURIComponent(t)}`} className="text-zinc-400 hover:underline mr-1">#{t}</Link>)}</>}
                  </div>
                  {a.content && <p className="text-[12.5px] text-zinc-400 mt-1 whitespace-pre-wrap">{a.content}</p>}
                  <Links stubs={data.stubs[a.id]} />
                  <Journey events={data.events[a.id]} />
                </li>
              ))}
            </ul>
          ) : <Empty>No active items match.</Empty>}
        </Panel>

        <Panel title="Archive — out of mind, kept whole" right={`${archive.length}${data.archive.length === 300 ? '+' : ''}`}>
          {archive.length ? (
            <ul className="divide-y divide-zinc-800/70">
              {archive.map(a => (
                <li key={a.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/daemon/memory?item=${lineageOf(a)}`} className="text-zinc-200 font-medium hover:underline">{a.title}</Link>
                    <Badge>{a.type}</Badge>
                    <Badge tone="violet">depth {a.depth}</Badge>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 font-mono">
                    archived {fmtTime(a.archived_at)}
                    {a.tags.length > 0 && <> · {a.tags.map(t => <span key={t} className="mr-1">#{t}</span>)}</>}
                  </div>
                  {a.outcome && <p className="text-[12px] text-zinc-300 mt-1"><span className="text-zinc-500">outcome:</span> {a.outcome}</p>}
                  {a.why_archived && <p className="text-[12px] text-zinc-400"><span className="text-zinc-500">why archived:</span> {a.why_archived}</p>}
                  {a.content && <details className="mt-1"><summary className="text-[11px] text-zinc-500 cursor-pointer">content</summary><p className="text-[12.5px] text-zinc-400 whitespace-pre-wrap mt-1">{a.content}</p></details>}
                  <Links stubs={data.stubs[a.id]} />
                  <Journey events={a.original_id ? data.events[a.original_id] : undefined} />
                </li>
              ))}
            </ul>
          ) : <Empty>No archived items match.</Empty>}
        </Panel>
      </div>
      <p className="text-[11px] text-zinc-600 mt-3">
        Journey events (created / archived / promoted) are recorded from daemon_v4.sql onward; earlier archivals were backfilled, earlier promotions and creations were never recorded.
      </p>
    </div>
  )
}
