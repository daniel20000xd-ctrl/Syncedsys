import Markdown from 'react-markdown'
import type { ReactNode } from 'react'
import type { DiffLine } from '@/lib/daemon/diff'

// Server-safe presentational pieces for the daemon console. Times are formatted in
// DAEMON_TZ on the server.

const TZ = () => process.env.DAEMON_TZ || 'Europe/Stockholm'

export function fmtTime(iso: string | null | undefined, withDate = true): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ(), hourCycle: 'h23',
    ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  const abs = Math.abs(s)
  const unit = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : abs < 172_800 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86_400)}d`
  return s >= 0 ? `${unit} ago` : `in ${unit}`
}

export const usd = (n: number | string | null | undefined, dp = 4) => `$${Number(n ?? 0).toFixed(dp)}`

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-lg font-semibold text-zinc-100">{children}</h1>
      {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  )
}

export function Panel({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`border border-zinc-800 bg-zinc-900/60 rounded ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-800">
          <h2 className="text-[11px] uppercase tracking-wider text-zinc-400">{title}</h2>
          {right && <div className="text-xs text-zinc-500">{right}</div>}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  )
}

const TONES = {
  zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  green: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  red: 'bg-red-950 text-red-300 border-red-800',
  amber: 'bg-amber-950 text-amber-300 border-amber-800',
  blue: 'bg-sky-950 text-sky-300 border-sky-800',
  violet: 'bg-violet-950 text-violet-300 border-violet-800',
} as const
export type Tone = keyof typeof TONES

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-block px-1.5 py-px rounded border text-[10px] font-mono whitespace-nowrap ${TONES[tone]}`}>{children}</span>
}

export const directionTone = (d: string): Tone => (d === 'expand' ? 'amber' : d === 'narrow' ? 'blue' : 'zinc')
export const verdictTone = (v: string): Tone =>
  v === 'accepted' ? 'green' : v === 'implemented' ? 'violet' : v === 'rejected' ? 'red' : v === 'open' ? 'amber' : 'zinc'
export const callTone = (c: string): Tone =>
  c === 'heartbeat' ? 'blue' : c === 'reflection' ? 'violet' : c === 'meta' ? 'amber' : c === 'input' ? 'green' : 'zinc'

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'warn' | 'good' }) {
  const color = tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-300' : tone === 'good' ? 'text-emerald-300' : 'text-zinc-100'
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`font-mono text-sm ${color} truncate`}>{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 truncate">{sub}</div>}
    </div>
  )
}

export function Md({ children }: { children: string }) {
  return (
    <div className="text-zinc-300 text-[13px] leading-relaxed break-words [&_h1]:text-zinc-100 [&_h1]:font-semibold [&_h2]:text-zinc-100 [&_h2]:font-semibold [&_h2]:mt-3 [&_h3]:text-zinc-200 [&_h3]:font-medium [&_h3]:mt-2 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:rounded [&_a]:text-sky-400 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-2 [&_blockquote]:text-zinc-400">
      <Markdown>{children}</Markdown>
    </div>
  )
}

export function Empty({ children = 'Nothing yet.' }: { children?: ReactNode }) {
  return <p className="text-xs text-zinc-600 italic">{children}</p>
}

export function DiffView({ lines, context = 2 }: { lines: DiffLine[]; context?: number }) {
  // Collapse long unchanged stretches, keeping `context` lines around each change.
  const keep = lines.map((l, i) => l.op !== 'same' || lines.slice(Math.max(0, i - context), i + context + 1).some(x => x.op !== 'same'))
  const out: ReactNode[] = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++
      return
    }
    if (skipped) out.push(<div key={`s${i}`} className="text-zinc-600 px-2">⋯ {skipped} unchanged</div>)
    skipped = 0
    const cls = l.op === 'add' ? 'bg-emerald-950/60 text-emerald-200' : l.op === 'del' ? 'bg-red-950/60 text-red-300 line-through decoration-red-800' : 'text-zinc-500'
    out.push(<div key={i} className={`px-2 whitespace-pre-wrap ${cls}`}>{l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : '  '}{l.text || ' '}</div>)
  })
  if (skipped) out.push(<div key="tail" className="text-zinc-600 px-2">⋯ {skipped} unchanged</div>)
  if (!lines.some(l => l.op !== 'same')) return <Empty>No changes.</Empty>
  return <div className="font-mono text-[12px] leading-5 border border-zinc-800 rounded overflow-x-auto">{out}</div>
}

export function Bar({ value, max, tone = 'bg-sky-500', label }: { value: number; max: number; tone?: string; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <div className="flex-1 h-2 bg-zinc-800 rounded overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${pct}%` }} /></div>
      {label !== undefined && <span className="text-zinc-400 w-24 text-right truncate">{label}</span>}
    </div>
  )
}

export function Json({ value }: { value: unknown }) {
  return <pre className="font-mono text-[11px] text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
}

export function ErrorPanel({ error }: { error: unknown }) {
  return (
    <Panel title="Error">
      <p className="text-red-400 font-mono text-xs">{(error as Error)?.message ?? String(error)}</p>
      <p className="text-zinc-500 text-xs mt-2">If this mentions a missing table or column, apply the pending supabase/daemon*.sql migrations.</p>
    </Panel>
  )
}
