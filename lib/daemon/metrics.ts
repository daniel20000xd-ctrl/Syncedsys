import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { addDays, localDate, localHour, startOfLocalDay } from './time'

// Metrics for the weekly meta call, computed in code so the model interprets numbers
// rather than recalling them. computeMetricsFromData is pure; computeMetrics loads the
// rows and calls it.

export type MetricRows = {
  messages: { direction: string; call_type: string; thread_id: string | null; created_at: string }[]
  threads: { id: string; opened_by: string; expects_reply: boolean; status: string; opened_at: string; closed_at: string | null; close_reason: string | null }[]
  active: { title: string; status: string; reschedule_count: number; last_touched: string }[]
  archive: { archived_at: string }[]
  usage: { call_type: string; model: string; cost_usd: number | string; error: string | null; attempt: number; created_at: string; dry_run?: boolean }[]
  // Versions written in the window, plus the one before them (for the first diff).
  notes: { version: number; content: string; created_at: string }[]
  notesTotal: number
  proposals: { category: string; direction: string; verdict: string; cycle_at: string }[]
  ticks: { outcome: string; created_at: string }[]
}

export type MetricConfig = {
  now: Date
  windowDays: number
  tz: string
  wakeHour: number
  sleepHour: number
  dailyCapUsd: number | null
}

const ms = (iso: string) => Date.parse(iso)
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp
const inRange = (iso: string | null, from: number, to: number) => iso !== null && ms(iso) >= from && ms(iso) < to

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo))
}

const rate = (num: number, den: number) => (den ? round(num / den, 3) : null)

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1
  return out
}

function weekday(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(d)
}

// Lines added + removed between two versions, ignoring order and blank lines.
export function lineDiffSize(a: string, b: string): number {
  const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)
  const count = (xs: string[]) => {
    const m = new Map<string, number>()
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
    return m
  }
  const ca = count(lines(a))
  const cb = count(lines(b))
  let diff = 0
  for (const k of new Set([...ca.keys(), ...cb.keys()])) diff += Math.abs((ca.get(k) ?? 0) - (cb.get(k) ?? 0))
  return diff
}

// Longest stretch without a ping inside waking hours, per local day, clipped to [from, to).
function longestWakingSilence(pingTimes: number[], from: number, to: number, cfg: MetricConfig) {
  if (cfg.wakeHour >= cfg.sleepHour) return null
  let best: { minutes: number; date: string } | null = null
  let date = localDate(new Date(from), cfg.tz)
  const lastDate = localDate(new Date(to - 1), cfg.tz)
  for (let guard = 0; date <= lastDate && guard < 400; guard++, date = addDays(date, 1)) {
    const dayStart = startOfLocalDay(new Date(`${date}T12:00:00Z`), cfg.tz).getTime()
    const start = Math.max(dayStart + cfg.wakeHour * 3_600_000, from)
    const end = Math.min(dayStart + cfg.sleepHour * 3_600_000, to)
    if (end <= start) continue
    const points = [start, ...pingTimes.filter(t => t > start && t < end), end]
    for (let i = 1; i < points.length; i++) {
      const minutes = round((points[i] - points[i - 1]) / 60_000, 0)
      if (!best || minutes > best.minutes) best = { minutes, date }
    }
  }
  return best
}

function windowMetrics(rows: MetricRows, from: number, to: number, cfg: MetricConfig) {
  const days = (to - from) / 86_400_000

  // Pings = outbound heartbeat messages. A ping is replied to when the user writes in
  // the same thread afterwards (up to now, not just within the window).
  const pings = rows.messages
    .filter(m => m.direction === 'out' && m.call_type === 'heartbeat' && inRange(m.created_at, from, to))
    .sort((a, b) => ms(a.created_at) - ms(b.created_at))
  const inboundByThread = new Map<string, number[]>()
  for (const m of rows.messages) {
    if (m.direction !== 'in' || !m.thread_id) continue
    inboundByThread.set(m.thread_id, [...(inboundByThread.get(m.thread_id) ?? []), ms(m.created_at)])
  }
  const replyMinutes: number[] = []
  const byHour: Record<string, { pings: number; replied: number; reply_rate: number | null }> = {}
  const byWeekday: Record<string, { pings: number; replied: number; reply_rate: number | null }> = {}
  let unthreaded = 0
  for (const p of pings) {
    const t = ms(p.created_at)
    const firstReply = p.thread_id ? (inboundByThread.get(p.thread_id) ?? []).filter(x => x > t).sort((a, b) => a - b)[0] : undefined
    if (!p.thread_id) unthreaded++
    if (firstReply !== undefined) replyMinutes.push((firstReply - t) / 60_000)
    const d = new Date(t)
    for (const [bucket, key] of [[byHour, String(localHour(d, cfg.tz)).padStart(2, '0')], [byWeekday, weekday(d, cfg.tz)]] as const) {
      const b = bucket[key] ?? { pings: 0, replied: 0, reply_rate: null }
      b.pings++
      if (firstReply !== undefined) b.replied++
      b.reply_rate = rate(b.replied, b.pings)
      bucket[key] = b
    }
  }
  const pingTimes = pings.map(p => ms(p.created_at))
  const pingGaps = pingTimes.slice(1).map((t, i) => (t - pingTimes[i]) / 60_000)

  // Threads opened in the window.
  const opened = rows.threads.filter(t => inRange(t.opened_at, from, to))
  const hasReply = (id: string) => (inboundByThread.get(id) ?? []).length > 0
  const aiOpened = opened.filter(t => t.opened_by === 'ai')
  const aiUnanswered = aiOpened.filter(t => !hasReply(t.id))

  const usage = rows.usage.filter(u => inRange(u.created_at, from, to))
  const calls = usage.filter(u => u.model !== 'n/a')
  const warnings = usage.filter(u => u.model === 'n/a')
  const cost = (xs: typeof usage) => round(xs.reduce((s, u) => s + Number(u.cost_usd ?? 0), 0), 4)
  const totalCost = cost(calls)
  const costByType: Record<string, number> = {}
  for (const type of new Set(calls.map(c => c.call_type))) costByType[type] = cost(calls.filter(c => c.call_type === type))
  const costByDay: Record<string, number> = {}
  for (const c of calls) {
    const day = localDate(new Date(ms(c.created_at)), cfg.tz)
    costByDay[day] = round((costByDay[day] ?? 0) + Number(c.cost_usd ?? 0), 4)
  }
  const errorsByType: Record<string, { calls: number; errors: number; retries: number }> = {}
  for (const c of calls) {
    const e = errorsByType[c.call_type] ?? { calls: 0, errors: 0, retries: 0 }
    e.calls++
    if (c.error) e.errors++
    if (c.attempt > 1) e.retries++
    errorsByType[c.call_type] = e
  }

  const heartbeatOk = calls.filter(c => c.call_type === 'heartbeat' && !c.error && !c.dry_run).length
  const ticks = rows.ticks.filter(t => inRange(t.created_at, from, to))

  const notesInWindow = rows.notes.filter(n => inRange(n.created_at, from, to)).sort((a, b) => a.version - b.version)
  const diffs = notesInWindow.map(n => {
    const prev = rows.notes.filter(p => p.version < n.version).sort((a, b) => b.version - a.version)[0]
    return prev ? lineDiffSize(prev.content, n.content) : null
  }).filter((d): d is number => d !== null)

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    pings: {
      sent: pings.length,
      replied: replyMinutes.length,
      reply_rate: rate(replyMinutes.length, pings.length),
      without_thread: unthreaded,
      minutes_to_reply_median: percentile(replyMinutes, 0.5),
      minutes_to_reply_p90: percentile(replyMinutes, 0.9),
      by_local_hour: byHour,
      by_weekday: byWeekday,
      minutes_between_pings_median: percentile(pingGaps, 0.5),
      minutes_between_pings_p90: percentile(pingGaps, 0.9),
      longest_waking_silence: longestWakingSilence(pingTimes, from, Math.min(to, cfg.now.getTime()), cfg),
    },
    tasks: {
      marked_done: rows.active.filter(a => a.status === 'done' && inRange(a.last_touched, from, to)).length,
      archived: rows.archive.filter(a => inRange(a.archived_at, from, to)).length,
    },
    threads: {
      opened: opened.length,
      opened_by_ai: aiOpened.length,
      opened_by_user: opened.length - aiOpened.length,
      with_a_reply: opened.filter(t => hasReply(t.id)).length,
      closed_stale: rows.threads.filter(t => t.close_reason === 'stale' && inRange(t.closed_at, from, to)).length,
      ai_threads_abandonment_rate: rate(aiUnanswered.length, aiOpened.length),
      expects_reply_never_answered: aiUnanswered.filter(t => t.expects_reply).length,
    },
    heartbeats: {
      calls_succeeded: heartbeatOk,
      chose_not_to_ping: Math.max(0, heartbeatOk - pings.length),
      scheduler_ticks: countBy(ticks, t => t.outcome),
    },
    operating_notes: {
      versions_written: notesInWindow.length,
      changed_lines_per_version_median: percentile(diffs, 0.5),
      changed_lines_total: diffs.reduce((s, d) => s + d, 0),
    },
    cost_usd: {
      total: totalCost,
      by_call_type: costByType,
      pct_of_daily_cap_avg: cfg.dailyCapUsd ? round((totalCost / (cfg.dailyCapUsd * days)) * 100, 1) : null,
      pct_of_daily_cap_max_day: cfg.dailyCapUsd && Object.keys(costByDay).length
        ? round((Math.max(...Object.values(costByDay)) / cfg.dailyCapUsd) * 100, 1)
        : null,
    },
    errors: {
      by_call_type: errorsByType,
      warnings: warnings.length,
    },
  }
}

export function computeMetricsFromData(rows: MetricRows, cfg: MetricConfig) {
  const now = cfg.now.getTime()
  const span = cfg.windowDays * 86_400_000
  const open = rows.active.filter(a => a.status !== 'done')
  const rescheduleCounts = rows.active.map(a => a.reschedule_count)
  const cycles = [...new Set(rows.proposals.map(p => p.cycle_at))].sort()
  const lastCycle = cycles.at(-1)

  return {
    generated_at: cfg.now.toISOString(),
    window_days: cfg.windowDays,
    current: windowMetrics(rows, now - span, now, cfg),
    prior: windowMetrics(rows, now - 2 * span, now - span, cfg),
    // Point-in-time: there is no history of reschedules, only the current counter.
    snapshot: {
      active_items: rows.active.length,
      not_done: open.length,
      by_status: countBy(rows.active, a => a.status),
      with_any_reschedule: rows.active.filter(a => a.reschedule_count > 0).length,
      reschedule_count_median: percentile(rescheduleCounts, 0.5),
      reschedule_histogram: countBy(rows.active, a => String(a.reschedule_count)),
      most_rescheduled: [...rows.active]
        .filter(a => a.reschedule_count > 0)
        .sort((a, b) => b.reschedule_count - a.reschedule_count)
        .slice(0, 5)
        .map(a => ({ title: a.title, reschedule_count: a.reschedule_count, status: a.status })),
      operating_notes_versions_total: rows.notesTotal,
      operating_notes_latest_chars: [...rows.notes].sort((a, b) => b.version - a.version)[0]?.content.length ?? null,
    },
    proposals: {
      total: rows.proposals.length,
      by_verdict: countBy(rows.proposals, p => p.verdict),
      by_category: countBy(rows.proposals, p => p.category),
      by_direction: countBy(rows.proposals, p => p.direction),
      last_cycle_by_direction: lastCycle ? countBy(rows.proposals.filter(p => p.cycle_at === lastCycle), p => p.direction) : {},
    },
    definitions: {
      pings: 'Outbound heartbeat messages. Replied = the user wrote in the same thread afterwards. Pings from before threads existed cannot be attributed (without_thread).',
      tasks: 'marked_done: active items with status done last touched in the window. archived: items archived in the window, whatever the outcome — completion is not recorded separately.',
      abandonment: 'Share of threads opened by the daemon in the window that have no reply from the user.',
      heartbeats: 'chose_not_to_ping = successful heartbeat calls minus pings. scheduler_ticks counts recorded tick outcomes (locked = skipped because another call held the lock); ticks before tick logging existed are absent.',
      longest_waking_silence: 'Longest stretch with no ping inside waking hours on any single day, in minutes, counting from wake time and to sleep time (or now).',
      notes_churn: 'Changed lines = lines added plus removed versus the previous version, ignoring order.',
      cost: 'Model calls only (dry runs from the console included, since they are real spend); warning rows are excluded. pct_of_daily_cap_avg = window total / (cap × days).',
      errors: 'Per call type: ledger rows, rows with an error, rows that were retry attempts. warnings = code-side warning rows (notes over cap, dropped model output, noisy cycles).',
    },
  }
}

export type Metrics = ReturnType<typeof computeMetricsFromData>

export async function computeMetrics(userId: string, windowDays = 7): Promise<Metrics> {
  const now = new Date()
  const since = new Date(now.getTime() - 2 * windowDays * 86_400_000).toISOString()
  const admin = createAdminClient()
  const must = <T>(res: { data: T[] | null; error: { message: string } | null }, what: string): T[] => {
    if (res.error) throw new Error(`metrics: ${what} read failed: ${res.error.message}`)
    return res.data ?? []
  }

  const [messages, threads, active, archive, usage, notes, notesBefore, notesCount, proposals, ticks] = await Promise.all([
    admin.from('daemon_interaction_log').select('direction, call_type, thread_id, created_at').eq('user_id', userId).gte('created_at', since).limit(20_000),
    admin.from('daemon_threads').select('id, opened_by, expects_reply, status, opened_at, closed_at, close_reason').eq('user_id', userId).or(`opened_at.gte."${since}",closed_at.gte."${since}"`).limit(5_000),
    admin.from('daemon_active').select('title, status, reschedule_count, last_touched').eq('user_id', userId),
    admin.from('daemon_archive').select('archived_at').eq('user_id', userId).gte('archived_at', since),
    admin.from('daemon_usage').select('call_type, model, cost_usd, error, attempt, created_at, dry_run').gte('created_at', since).limit(20_000),
    admin.from('daemon_operating_notes').select('version, content, created_at').eq('user_id', userId).gte('created_at', since),
    admin.from('daemon_operating_notes').select('version, content, created_at').eq('user_id', userId).lt('created_at', since).order('version', { ascending: false }).limit(1),
    admin.from('daemon_operating_notes').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    admin.from('daemon_proposals').select('category, direction, verdict, cycle_at').eq('user_id', userId),
    admin.from('daemon_tick_log').select('outcome, created_at').gte('created_at', since).limit(20_000),
  ])

  return computeMetricsFromData({
    messages: must(messages, 'interaction log'),
    threads: must(threads, 'threads'),
    active: must(active, 'active'),
    archive: must(archive, 'archive'),
    usage: must(usage, 'usage'),
    notes: [...must(notesBefore, 'operating notes'), ...must(notes, 'operating notes')],
    notesTotal: notesCount.count ?? 0,
    proposals: must(proposals, 'proposals'),
    ticks: must(ticks, 'tick log'),
  }, {
    now,
    windowDays,
    tz: daemonEnv.tz(),
    wakeHour: daemonEnv.wakeHour(),
    sleepHour: daemonEnv.sleepHour(),
    dailyCapUsd: daemonEnv.dailyCostCapUsd(),
  })
}
