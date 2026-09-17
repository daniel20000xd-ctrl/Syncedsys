import Link from 'next/link'
import { getThreadDetail, getThreads } from '@/app/daemonActions'
import { Badge, callTone, Empty, ErrorPanel, fmtAgo, fmtTime, PageTitle, Panel, type Tone } from '../_components/ui'

const statusTone = (s: string): Tone => (s === 'open' ? 'amber' : s === 'answered' ? 'green' : 'zinc')

export default async function ThreadsPage({ searchParams }: { searchParams: Promise<{ id?: string; status?: string }> }) {
  const { id, status } = await searchParams
  try {
    return id ? await Detail({ id }) : await List({ status })
  } catch (e) {
    return <ErrorPanel error={e} />
  }
}

async function List({ status }: { status?: string }) {
  const { threads, previews } = await getThreads({ status })
  return (
    <div>
      <PageTitle sub="Every exchange belongs to a thread. Routing is deterministic, done by code.">Threads</PageTitle>
      <div className="flex gap-2 mb-3 text-xs">
        {['', 'open', 'answered', 'closed'].map(s => (
          <Link key={s} href={s ? `/daemon/threads?status=${s}` : '/daemon/threads'} className={(status ?? '') === s ? 'text-zinc-100 underline' : 'text-zinc-500'}>
            {s || 'all'}
          </Link>
        ))}
      </div>
      <Panel>
        {threads.length ? (
          <table className="w-full text-[12.5px]">
            <thead className="text-[10px] uppercase tracking-wider text-zinc-500 text-left">
              <tr><th className="pb-1.5 font-normal">topic</th><th className="font-normal">status</th><th className="font-normal">opened by</th><th className="font-normal">last message</th><th className="font-normal text-right">activity</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {threads.map(t => {
                const p = previews[t.id]
                return (
                  <tr key={t.id} className="align-top">
                    <td className="py-1.5 pr-3">
                      <Link href={`/daemon/threads?id=${t.id}`} className="text-zinc-100 hover:underline">{t.topic || '(no topic)'}</Link>
                      {t.expects_reply && <> <Badge tone="amber">expects reply</Badge></>}
                    </td>
                    <td className="pr-3"><Badge tone={statusTone(t.status)}>{t.status}</Badge>{t.close_reason && <span className="text-[11px] text-zinc-600"> {t.close_reason}</span>}</td>
                    <td className="pr-3 font-mono text-zinc-400">{t.opened_by}</td>
                    <td className="pr-3 text-zinc-400 max-w-md truncate">{p ? <><span className="text-zinc-600">{p.direction === 'in' ? 'you:' : 'daemon:'}</span> {p.content}</> : '—'}</td>
                    <td className="text-right font-mono text-zinc-500 whitespace-nowrap">{fmtAgo(t.last_activity_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : <Empty>No threads.</Empty>}
      </Panel>
    </div>
  )
}

async function Detail({ id }: { id: string }) {
  const data = await getThreadDetail(id)
  if (!data) return <Empty>Thread not found.</Empty>
  const { thread, messages, dayEntries, resolved, pendingOutbound } = data
  const ref = (rid: string) => (
    <li key={rid} className="text-[12px]">
      <Link href={`/daemon/memory?item=${rid}`} className="text-sky-500 hover:underline">{resolved[rid] ?? '(not found)'}</Link>
      <span className="text-zinc-600 font-mono text-[10px]"> {rid}</span>
    </li>
  )

  return (
    <div>
      <Link href="/daemon/threads" className="text-xs text-zinc-500">← threads</Link>
      <PageTitle sub={<span className="font-mono">{thread.id}</span>}>{thread.topic || '(no topic)'}</PageTitle>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Panel title="Exchange" right={`${messages.length} messages`}>
          {messages.length ? (
            <ol className="space-y-2">
              {messages.map(m => (
                <li key={m.id} className={`rounded border p-2 ${m.direction === 'in' ? 'border-zinc-700 bg-zinc-900 ml-8' : 'border-zinc-800 mr-8'}`}>
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-0.5">
                    <span className="font-mono">{fmtTime(m.created_at)}</span>
                    <span>{m.direction === 'in' ? 'you' : 'daemon'}</span>
                    <Badge tone={callTone(m.call_type)}>{m.call_type}</Badge>
                    {m.direction === 'out' && <span>{m.push_sent ? 'pushed' : 'not pushed'}</span>}
                  </div>
                  <p className="text-[13px] text-zinc-200 whitespace-pre-wrap">{m.content}</p>
                </li>
              ))}
            </ol>
          ) : <Empty>No messages.</Empty>}
          {pendingOutbound.filter(p => !p.delivered_at).map((p, i) => (
            <div key={i} className="mt-2 rounded border border-dashed border-amber-800 p-2 text-[13px] text-amber-200">
              <div className="text-[11px] text-amber-500">held for waking hours since {fmtTime(p.created_at)}</div>
              {p.content}
            </div>
          ))}
        </Panel>

        <div className="space-y-4">
          <Panel title="Thread">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-[12px]">
              <dt className="text-zinc-500">status</dt><dd><Badge tone={statusTone(thread.status)}>{thread.status}</Badge></dd>
              <dt className="text-zinc-500">opened by</dt><dd className="font-mono">{thread.opened_by}</dd>
              <dt className="text-zinc-500">expects reply</dt><dd className="font-mono">{String(thread.expects_reply)}</dd>
              <dt className="text-zinc-500">opened</dt><dd className="font-mono">{fmtTime(thread.opened_at)}</dd>
              <dt className="text-zinc-500">last activity</dt><dd className="font-mono">{fmtTime(thread.last_activity_at)}</dd>
              <dt className="text-zinc-500">closed</dt><dd className="font-mono">{thread.closed_at ? `${fmtTime(thread.closed_at)} — ${thread.close_reason ?? ''}` : '—'}</dd>
            </dl>
          </Panel>
          <Panel title="Question">{thread.question ? <p className="text-[13px] text-zinc-200">{thread.question}</p> : <Empty>None asked.</Empty>}</Panel>
          <Panel title="Reasoning (never shown on the phone)">
            {thread.reasoning ? <p className="text-[13px] text-amber-100/90 whitespace-pre-wrap">{thread.reasoning}</p> : <Empty>None recorded.</Empty>}
          </Panel>
          <Panel title="References (resolved now)">
            {thread.referenced_active_ids.length + thread.referenced_archive_ids.length ? (
              <ul className="space-y-1">{[...thread.referenced_active_ids, ...thread.referenced_archive_ids].map(ref)}</ul>
            ) : <Empty>No item references.</Empty>}
            {thread.referenced_log_dates.length > 0 && (
              <div className="mt-2 text-[12px]">
                days:{' '}
                {thread.referenced_log_dates.map(d => <Link key={d} href={`/daemon/logs?date=${d}`} className="text-sky-500 mr-2">{d}</Link>)}
              </div>
            )}
          </Panel>
          <Panel title="Day-log entries on this thread">
            {dayEntries.length ? (
              <ul className="space-y-1">
                {dayEntries.map((e, i) => (
                  <li key={i} className="text-[12px]"><span className="font-mono text-zinc-500">{fmtTime(e.created_at)}</span> <Badge tone={callTone(e.call_type)}>{e.call_type}</Badge> {e.content}</li>
                ))}
              </ul>
            ) : <Empty>None.</Empty>}
          </Panel>
        </div>
      </div>
    </div>
  )
}
