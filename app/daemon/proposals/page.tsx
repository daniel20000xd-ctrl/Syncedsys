import Link from 'next/link'
import { getProposals } from '@/app/daemonActions'
import { VerdictForm } from '../_components/VerdictForm'
import { Badge, directionTone, Empty, ErrorPanel, fmtTime, Json, Md, PageTitle, Panel, verdictTone } from '../_components/ui'

const DIRECTIONS = ['expand', 'narrow', 'neutral'] as const
const VERDICTS = ['open', 'accepted', 'implemented', 'rejected', 'superseded'] as const
const DIR_COLOR: Record<string, string> = { expand: 'bg-amber-500', narrow: 'bg-sky-500', neutral: 'bg-zinc-500' }

function DirectionBar({ counts }: { counts: Record<string, number> }) {
  const total = DIRECTIONS.reduce((s, d) => s + (counts[d] ?? 0), 0)
  if (!total) return <div className="h-2 bg-zinc-800 rounded" />
  return (
    <div className="flex h-2 rounded overflow-hidden bg-zinc-800">
      {DIRECTIONS.map(d => (counts[d] ? <div key={d} className={DIR_COLOR[d]} style={{ width: `${(counts[d] / total) * 100}%` }} title={`${d}: ${counts[d]}`} /> : null))}
    </div>
  )
}

export default async function ProposalsPage({ searchParams }: { searchParams: Promise<{ verdict?: string; direction?: string }> }) {
  const { verdict, direction } = await searchParams
  let all: Awaited<ReturnType<typeof getProposals>>
  try {
    all = await getProposals()
  } catch (e) {
    return <ErrorPanel error={e} />
  }

  const count = (rows: typeof all, key: 'direction' | 'verdict') =>
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {})
  const cumulative = count(all, 'direction')
  const cycles = [...new Set(all.map(p => p.cycle_at))].sort().reverse()
  const shown = all.filter(p => (!verdict || p.verdict === verdict) && (!direction || p.direction === direction))
  const filterLink = (k: 'verdict' | 'direction', v?: string) => {
    const q = new URLSearchParams({ ...(verdict ? { verdict } : {}), ...(direction ? { direction } : {}) })
    if (v) q.set(k, v)
    else q.delete(k)
    const s = q.toString()
    return `/daemon/proposals${s ? `?${s}` : ''}`
  }

  return (
    <div>
      <PageTitle sub="Inert: nothing here applies itself. You implement accepted proposals by hand, or not at all.">Proposals</PageTitle>

      <Panel title="Direction tally — expand vs narrow vs neutral" className="mb-4">
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">cumulative ({all.length})</div>
            <div className="flex gap-3 font-mono text-2xl mb-2">
              {DIRECTIONS.map(d => <span key={d} className={d === 'expand' ? 'text-amber-300' : d === 'narrow' ? 'text-sky-300' : 'text-zinc-400'} title={d}>{cumulative[d] ?? 0}</span>)}
            </div>
            <DirectionBar counts={cumulative} />
            <div className="flex gap-3 text-[10px] text-zinc-500 mt-1"><span className="text-amber-400">expand</span><span className="text-sky-400">narrow</span><span>neutral</span></div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">per cycle</div>
            {cycles.length ? (
              <ul className="space-y-1">
                {cycles.map(c => {
                  const rows = all.filter(p => p.cycle_at === c)
                  const dirs = count(rows, 'direction')
                  const onlyExpand = (dirs.expand ?? 0) === rows.length
                  return (
                    <li key={c} className="grid grid-cols-[130px_1fr_150px] items-center gap-2 text-[11px] font-mono">
                      <span className="text-zinc-400">{fmtTime(c)}</span>
                      <DirectionBar counts={dirs} />
                      <span className={onlyExpand ? 'text-amber-300' : 'text-zinc-500'}>
                        {DIRECTIONS.map(d => dirs[d] ?? 0).join(' / ')}{onlyExpand && ' only expand'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : <Empty>No cycles yet.</Empty>}
          </div>
        </div>
      </Panel>

      <div className="flex flex-wrap gap-4 mb-3 text-xs">
        <div className="flex gap-2 items-center">
          <span className="text-zinc-600">verdict:</span>
          <Link href={filterLink('verdict')} className={!verdict ? 'text-zinc-100 underline' : 'text-zinc-500'}>all</Link>
          {VERDICTS.map(v => {
            const n = all.filter(p => p.verdict === v).length
            return <Link key={v} href={filterLink('verdict', v)} className={verdict === v ? 'text-zinc-100 underline' : 'text-zinc-500'}>{v} ({n})</Link>
          })}
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-zinc-600">direction:</span>
          <Link href={filterLink('direction')} className={!direction ? 'text-zinc-100 underline' : 'text-zinc-500'}>all</Link>
          {DIRECTIONS.map(d => <Link key={d} href={filterLink('direction', d)} className={direction === d ? 'text-zinc-100 underline' : 'text-zinc-500'}>{d}</Link>)}
        </div>
      </div>

      {!shown.length && <Empty>No proposals match.</Empty>}
      <div className="space-y-4">
        {DIRECTIONS.map(d => {
          const group = shown.filter(p => p.direction === d)
          if (!group.length) return null
          return (
            <section key={d}>
              <h2 className="text-[11px] uppercase tracking-wider text-zinc-400 mb-2">{d} · {group.length}</h2>
              <div className="space-y-3">
                {group.map(p => (
                  <Panel
                    key={p.id}
                    title={<span className="flex flex-wrap items-center gap-1.5 normal-case tracking-normal"><Badge tone={directionTone(p.direction)}>{p.direction}</Badge><Badge>{p.category}</Badge><Badge tone={verdictTone(p.verdict)}>{p.verdict}</Badge><span className="text-zinc-100 text-[13px]">{p.title}</span></span>}
                    right={fmtTime(p.created_at)}
                  >
                    <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
                      <div className="min-w-0">
                        <Md>{p.body}</Md>
                        {p.supersedes && <p className="text-[11px] text-zinc-500 mt-1">supersedes <span className="font-mono">{p.supersedes}</span></p>}
                        {p.verdict !== 'open' && (
                          <p className="text-[12px] text-zinc-400 mt-2 border-t border-zinc-800 pt-2">
                            <Badge tone={verdictTone(p.verdict)}>{p.verdict}</Badge> {fmtTime(p.verdict_at)} — {p.verdict_reason ?? '(no reason)'}
                          </p>
                        )}
                        {p.verdict !== 'superseded' && <VerdictForm proposalId={p.id} current={p.verdict} />}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">evidence (copied from metrics by code)</div>
                        <Json value={p.evidence} />
                      </div>
                    </div>
                  </Panel>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
