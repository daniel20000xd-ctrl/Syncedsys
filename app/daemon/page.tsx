import Link from 'next/link'
import { getOverview } from '@/app/daemonActions'
import { AutoRefresh } from './_components/AutoRefresh'
import { OperatorControls } from './_components/OperatorControls'
import { Badge, Bar, callTone, directionTone, Empty, ErrorPanel, fmtAgo, fmtTime, Panel, Stat, usd } from './_components/ui'

export default async function DaemonOverview() {
  let data: Awaited<ReturnType<typeof getOverview>>
  try {
    data = await getOverview()
  } catch (e) {
    return <ErrorPanel error={e} />
  }
  const { state, lock, cost } = data
  const capPct = cost.capUsd ? (cost.todayUsd / cost.capUsd) * 100 : null

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Overview</h1>
        <AutoRefresh seconds={30} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4 min-w-0">
          <Panel title="State">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="enabled" value={state.enabled ? 'yes' : 'NO'} tone={state.enabled ? 'good' : 'bad'} />
              <Stat label="shadow mode" value={state.shadow_mode ? 'on' : 'OFF (live)'} tone={state.shadow_mode ? undefined : 'bad'} />
              <Stat label="next wake" value={fmtTime(state.next_wake_time, false)} sub={fmtAgo(state.next_wake_time)} />
              <Stat
                label="lock"
                value={lock.held ? `${lock.holder}` : 'free'}
                sub={lock.held ? `${lock.ageSeconds}s${lock.stale ? ' — STALE' : ''}` : undefined}
                tone={lock.stale ? 'bad' : lock.held ? 'warn' : undefined}
              />
              <Stat label="last heartbeat" value={fmtAgo(state.last_heartbeat_at)} sub={fmtTime(state.last_heartbeat_at)} />
              <Stat label="last reflection" value={fmtAgo(state.last_reflection_at)} sub={state.last_reflection_day ?? undefined} />
              <Stat label="last meta" value={fmtAgo(state.last_meta_at)} sub={fmtTime(state.last_meta_at)} />
              <Stat label="held for waking hours" value={data.pendingOutbound} sub={`${data.wakeHours.wake}:00–${data.wakeHours.sleep}:00 ${data.wakeHours.tz}`} />
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-[11px] text-zinc-500 mb-1">
                <span>cost today</span>
                <span className="font-mono">{usd(cost.todayUsd)} / {cost.capUsd === null ? 'NO CAP SET (all calls blocked)' : usd(cost.capUsd, 2)}</span>
              </div>
              <Bar value={cost.todayUsd} max={cost.capUsd ?? 1} tone={capPct !== null && capPct >= 80 ? 'bg-red-500' : 'bg-emerald-500'} label={capPct === null ? '—' : `${capPct.toFixed(1)}%`} />
              {cost.unknownCostCalls > 0 && (
                <p className="text-[11px] text-red-400 font-mono mt-1.5">
                  ⚠ {cost.unknownCostCalls} call{cost.unknownCostCalls === 1 ? '' : 's'} today priced at unknown cost (no row in daemon_model_prices) —
                  the total above is a floor, not the real spend, and the cap is treating today as over budget until this is fixed. See{' '}
                  <Link href="/daemon/models" className="underline">Models</Link>.
                </p>
              )}
            </div>
          </Panel>

          <Panel title={`Day log — ${data.today}`} right={`${data.dayEntries.length} entries`}>
            {data.dayEntries.length ? (
              <ol className="space-y-1">
                {data.dayEntries.map(e => (
                  <li key={e.id} className="flex gap-2 text-[13px]">
                    <span className="font-mono text-zinc-500 shrink-0">{fmtTime(e.created_at, false)}</span>
                    <Badge tone={callTone(e.call_type)}>{e.call_type}</Badge>
                    <span className="text-zinc-300">{e.content}</span>
                    {e.thread_id && <Link href={`/daemon/threads?id=${e.thread_id}`} className="text-[11px] text-sky-500 shrink-0">thread</Link>}
                  </li>
                ))}
              </ol>
            ) : <Empty>No entries yet today.</Empty>}
          </Panel>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Open threads" right={<Link href="/daemon/threads?status=open" className="text-sky-500">all</Link>}>
              {data.openThreads.length ? (
                <ul className="space-y-1.5">
                  {data.openThreads.map(t => (
                    <li key={t.id} className="text-[13px]">
                      <Link href={`/daemon/threads?id=${t.id}`} className="text-zinc-200 hover:underline">{t.topic || '(no topic)'}</Link>{' '}
                      {t.expects_reply && <Badge tone="amber">awaiting reply</Badge>}{' '}
                      <span className="text-[11px] text-zinc-500">{t.opened_by} · {fmtAgo(t.last_activity_at)}</span>
                      {t.question && <div className="text-[12px] text-zinc-500 truncate">{t.question}</div>}
                    </li>
                  ))}
                </ul>
              ) : <Empty>No open threads.</Empty>}
            </Panel>
            <Panel title="Open proposals" right={<Link href="/daemon/proposals" className="text-sky-500">all</Link>}>
              {data.openProposals.length ? (
                <ul className="space-y-1.5">
                  {data.openProposals.map(p => (
                    <li key={p.id} className="text-[13px] flex gap-1.5 items-start">
                      <Badge tone={directionTone(p.direction)}>{p.direction}</Badge>
                      <Badge>{p.category}</Badge>
                      <span className="text-zinc-300">{p.title}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty>No open proposals.</Empty>}
            </Panel>
          </div>
        </div>

        <Panel title="Operator controls">
          <OperatorControls shadowMode={state.shadow_mode} enabled={state.enabled} lock={lock} debugAllowed={data.debugAllowed} />
        </Panel>
      </div>
    </div>
  )
}
