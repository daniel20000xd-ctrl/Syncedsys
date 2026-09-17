import { searchMemoryConsole } from '@/app/daemonActions'
import { Badge, Empty, Panel, fmtTime, type Tone } from './ui'

const matchTone = (why: string): Tone => (why.startsWith('both') ? 'green' : why.startsWith('vector') ? 'violet' : 'blue')

// Server component: runs searchMemory exactly as the daemon does, with scores shown and
// the default/prefetch thresholds marked, so retrieval quality can be judged by hand.
export async function MemorySearch({ query, minScore, kinds }: { query: string; minScore: number; kinds: string[] }) {
  const { hits, signals, vector, thresholds } = await searchMemoryConsole(query, { minScore, kinds, limit: 40 })
  return (
    <Panel
      title={<span className="normal-case tracking-normal">search &ldquo;{query}&rdquo;</span>}
      right={
        <span className="font-mono">
          {signals}{vector.disabledReason ? ` · vector off: ${vector.disabledReason}` : !vector.configured ? ' · vector not configured' : ''}
          {' '}· thresholds: default {thresholds.default}, prefetch {thresholds.prefetch}
        </span>
      }
      className="mb-4"
    >
      {hits.length ? (
        <table className="w-full text-[12px]">
          <thead className="text-[10px] uppercase tracking-wider text-zinc-500 text-left">
            <tr>{['score', 'kind', 'date', 'title / excerpt', 'matched'].map(h => <th key={h} className="font-normal pb-1 pr-3">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {hits.map(h => {
              const clears = h.score >= thresholds.prefetch ? 'prefetch' : h.score >= thresholds.default ? 'default' : null
              return (
                <tr key={`${h.kind}${h.id}`} className="align-top">
                  <td className="pr-3 py-1.5 font-mono whitespace-nowrap">
                    <span className={clears === 'prefetch' ? 'text-emerald-300' : clears ? 'text-amber-300' : 'text-zinc-600'}>{h.score.toFixed(3)}</span>
                    <div className="text-[10px] text-zinc-600">{clears ? `clears ${clears}` : 'below threshold'}</div>
                  </td>
                  <td className="pr-3"><Badge>{h.kind}</Badge></td>
                  <td className="pr-3 font-mono text-zinc-500 whitespace-nowrap">{fmtTime(h.created_at)}</td>
                  <td className="pr-3">
                    <div className="text-zinc-200">{h.title}</div>
                    <div className="text-zinc-400">&ldquo;{h.excerpt}&rdquo;</div>
                    <div className="text-[10px] font-mono text-zinc-600">{h.id}</div>
                  </td>
                  <td className="font-mono text-[11px] text-zinc-400">
                    <Badge tone={matchTone(h.why_matched)}>{h.why_matched.split(':')[0]}</Badge>
                    <div>fts {h.signals.fts ?? '—'} · vector {h.signals.vector ?? '—'} · decay {h.signals.decay}</div>
                    {h.signals.matched_terms.length > 0 && <div className="text-zinc-600">terms: {h.signals.matched_terms.join(', ')}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : <Empty>No matches at min score {minScore}.</Empty>}
    </Panel>
  )
}
