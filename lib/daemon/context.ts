import { createAdminClient } from '@/lib/supabase/admin'
import { readLatest, readRange, readCurrent, renderForContext } from './files'
import { addDays, describeNow, localDate, reflectionDay, startOfLocalDay } from './time'
import { getLatestNotes, getRecentNotes } from './notes'
import { listProposals } from './proposals'
import type { Metrics } from './metrics'
import { recordRecall, REFLECTION_ARCHIVE_LIMIT, renderHits, searchMemoryMany, type SearchHit } from './search'
import { assembleDayLog, ensureDaylogMigrated, loadDayEntries } from './daylog'
import { buildThreadContext, renderThreadSummaries } from './threads'
import { loadLinkStubs } from './links'
import type { Turn } from './gemini'

export type ActiveItem = {
  id: string
  type: string
  title: string
  content: string
  status: string
  deadline: string | null
  tags: string[]
  reschedule_count: number
  last_nudged_at: string | null
  awaiting_report_thread_id: string | null
  awaiting_report_since: string | null
  created_at: string
  last_touched: string
}

export type ArchiveItem = {
  id: string
  original_id: string | null
  type: string
  title: string
  content: string
  tags: string[]
  outcome: string | null
  why_archived: string | null
  depth: number
  archived_at: string
  created_at: string
}

type LogRow = { direction: string; call_type: string; content: string; created_at: string; thread_id?: string | null }

export async function loadActive(userId: string): Promise<ActiveItem[]> {
  const { data, error } = await createAdminClient()
    .from('daemon_active').select('*').eq('user_id', userId).order('created_at', { ascending: true })
  if (error) throw new Error(`daemon_active read failed: ${error.message}`)
  return (data ?? []) as ActiveItem[]
}

function section(title: string, body: string): string {
  return `---BEGIN ${title}---\n${body.trim() || '(empty)'}\n---END ${title}---`
}

// Linked items appear as one-line stubs only, one hop, so context can't balloon
// through link chains.
async function renderWithLinks<T extends { id: string }>(userId: string, items: T[]): Promise<string> {
  if (!items.length) return '(none)'
  const stubs = await loadLinkStubs(userId, items.map(i => i.id))
  return JSON.stringify(items.map(item => {
    const out: Record<string, unknown> = { ...item }
    delete out.user_id
    const links = stubs.get(item.id)
    if (links?.length) out.links = links.map(l => `[${l.kind} ${l.id}] ${l.title} — ${l.why}`)
    return out
  }), null, 2)
}

function renderLog(rows: LogRow[]): string {
  return rows.map(r => `[${r.created_at}] ${r.direction === 'in' ? 'USER' : `DAEMON(${r.call_type})`}: ${r.content}`).join('\n')
}

function header(callType: string): string {
  return `${describeNow()}\nCall type: ${callType}. Respond only with JSON matching the response schema.`
}

// Constant head of every call, in load order: operating notes → the day's log →
// thread context (if any). Kept small; it's paid for on every call.
async function head(userId: string, day: string, thread?: { id: string; excludeInbound: string[] }): Promise<string[]> {
  const today = localDate()
  const [notes, dayLog, threadCtx] = await Promise.all([
    getLatestNotes(userId),
    assembleDayLog(userId, day),
    thread ? buildThreadContext(userId, thread.id, today, thread.excludeInbound) : Promise.resolve(null),
  ])
  return [
    section('OPERATING NOTES', notes ? `(v${notes.version})\n${notes.content}` : '(none yet)'),
    section(`DAY LOG (${day}, so far)`, dayLog || '(no entries yet)'),
    ...(threadCtx !== null ? [section('THREAD', threadCtx)] : []),
  ]
}

// threadId is null only for dry runs.
export async function buildInputTurns(userId: string, threadId: string | null, messages: string[], related: SearchHit[] = []): Promise<Turn[]> {
  const today = localDate()
  await ensureDaylogMigrated(userId)
  const admin = createAdminClient()
  const [headSections, active, daylogs, calendar, log, proposals] = await Promise.all([
    head(userId, today, threadId ? { id: threadId, excludeInbound: messages } : undefined),
    loadActive(userId),
    readRange(userId, 'daylog', addDays(today, -3), addDays(today, -1), today),
    readRange(userId, 'calendar', today, addDays(today, 7), today),
    admin.from('daemon_interaction_log')
      .select('direction, call_type, content, created_at, thread_id')
      .eq('user_id', userId)
      .neq('call_type', 'system')
      .order('created_at', { ascending: false })
      .limit(40),
    listProposals(userId, { verdicts: ['open', 'accepted'] }),
  ])
  if (log.error) throw new Error(`interaction log read failed: ${log.error.message}`)
  // This thread's messages are already in THREAD.
  const history = ((log.data ?? []) as LogRow[]).filter(r => r.thread_id !== threadId).slice(0, 20).reverse()

  const context = [
    ...headSections,
    header('input'),
    section('ACTIVE ITEMS', await renderWithLinks(userId, active)),
    section('DAY LOG (previous 3 days)', renderForContext(daylogs)),
    section('CALENDAR (today + 7 days)', renderForContext(calendar)),
    section('RECENT INTERACTIONS (other threads)', renderLog(history)),
    // Only when something cleared the threshold — never padded with weak matches.
    ...(related.length
      ? [section('POSSIBLY RELATED, FROM BEFORE (automatic recall on this message; stubs with date and verbatim excerpt — link, never duplicate)', renderHits(related))]
      : []),
    ...(proposals.length
      ? [section('PROPOSALS AWAITING OR ACCEPTED (verdicts only if the user gives one in this message)', proposals
        .map(p => JSON.stringify({ id: p.id, verdict: p.verdict, category: p.category, direction: p.direction, title: p.title }))
        .join('\n'))]
      : []),
    messages.length > 1
      ? `The user sent ${messages.length} messages on this thread, in order, as the following turns.`
      : "The user's message on this thread follows.",
  ].join('\n\n')

  return [{ role: 'user', text: context }, ...messages.map(m => ({ role: 'user' as const, text: m }))]
}

export async function buildHeartbeatTurns(userId: string): Promise<Turn[]> {
  const today = localDate()
  await ensureDaylogMigrated(userId)
  const [headSections, active, threads, lastDaylog, calendar] = await Promise.all([
    head(userId, today),
    loadActive(userId),
    renderThreadSummaries(userId),
    readLatest(userId, 'daylog'),
    readRange(userId, 'calendar', today, today, today),
  ])
  const context = [
    ...headSections,
    header('heartbeat'),
    section('ACTIVE ITEMS', await renderWithLinks(userId, active)),
    section('UNCLOSED THREADS', threads),
    section('LATEST CLOSED DAY LOG', lastDaylog ? renderForContext([lastDaylog]) : '(none yet)'),
    section('CALENDAR (today)', renderForContext(calendar)),
  ].join('\n\n')
  return [{ role: 'user', text: context }]
}

// Reflection's archive pass: recall seeded from current active titles and the day's
// entries, archive only. Replaces the v1–v4 tag-overlap match.
async function recallArchive(userId: string, active: ActiveItem[], dayEntries: string[]): Promise<ArchiveItem[]> {
  const seeds = [...active.map(a => a.title), dayEntries.join('\n')].filter(q => q.trim())
  if (!seeds.length) return []
  const { hits, signals } = await searchMemoryMany(seeds, { userId, kinds: ['archive'], limit: REFLECTION_ARCHIVE_LIMIT })
  await recordRecall(userId, { mode: 'reflection', query: seeds.join(' | ').slice(0, 4000), signals, hits })
  if (!hits.length) return []
  const { data, error } = await createAdminClient().from('daemon_archive').select('*').in('id', hits.map(h => h.id))
  if (error) throw new Error(`daemon_archive read failed: ${error.message}`)
  const rows = new Map(((data ?? []) as ArchiveItem[]).map(r => [r.id, r]))
  return hits.flatMap(h => {
    const row = rows.get(h.id)
    return row ? [{ ...row, recall: { score: h.score, why_matched: h.why_matched } } as ArchiveItem] : []
  })
}

export async function buildReflectionTurns(userId: string): Promise<Turn[]> {
  const now = new Date()
  const day = reflectionDay(now)
  const today = localDate(now)
  const dayStart = startOfLocalDay(new Date(`${day}T12:00:00Z`))
  await ensureDaylogMigrated(userId)
  const admin = createAdminClient()
  const [headSections, active, threads, daylogs, calendar, log, entries] = await Promise.all([
    head(userId, day),
    loadActive(userId),
    renderThreadSummaries(userId, 100),
    readRange(userId, 'daylog', addDays(day, -7), addDays(day, -1), today),
    readCurrent(userId, 'calendar'),
    admin.from('daemon_interaction_log')
      .select('direction, call_type, content, created_at')
      .eq('user_id', userId)
      .neq('call_type', 'system')
      .gte('created_at', dayStart.toISOString())
      .order('created_at', { ascending: true })
      .limit(500),
    loadDayEntries(userId, day),
  ])
  if (log.error) throw new Error(`interaction log read failed: ${log.error.message}`)
  const logRows = (log.data ?? []) as LogRow[]
  const archive = await recallArchive(userId, active, entries.map(e => e.content))

  const context = [
    ...headSections,
    header('reflection'),
    `Reflecting on ${day}. day_log_close and calendar_roll are for ${day}; tomorrow_plan is for ${addDays(day, 1)}. operating_notes replaces the current version in full.`,
    section('ACTIVE ITEMS', await renderWithLinks(userId, active)),
    section('RELEVANT ARCHIVE (recalled by search; each carries its score)', await renderWithLinks(userId, archive)),
    section('UNCLOSED THREADS', threads),
    section('DAY LOG (previous 7 days)', renderForContext(daylogs)),
    section(`INTERACTIONS (${day})`, renderLog(logRows)),
    section('CALENDAR (current month)', calendar),
  ].join('\n\n')
  return [{ role: 'user', text: context }]
}

// Weekly meta call. Different horizon, different shape: no day log as the frame, and
// the only call that sees the self-description.
export async function loadSelfDescription(userId: string): Promise<{ version: number; content: string } | null> {
  const { data, error } = await createAdminClient()
    .from('daemon_self_description')
    .select('version, content')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`self-description read failed: ${error.message}`)
  return data
}

const lastBlocks = <T>(xs: T[], n: number) => xs.slice(Math.max(0, xs.length - n))

export async function buildMetaTurns(userId: string, metrics: Metrics): Promise<Turn[]> {
  const today = localDate()
  await ensureDaylogMigrated(userId)
  const [selfDescription, notes, proposals, reflections, daylogs, active] = await Promise.all([
    loadSelfDescription(userId),
    getRecentNotes(userId, 4),
    listProposals(userId),
    readRange(userId, 'reflections', addDays(today, -60), today, today),
    readRange(userId, 'daylog', addDays(today, -30), today, today),
    loadActive(userId),
  ])

  const context = [
    section('SELF-DESCRIPTION', selfDescription ? `(v${selfDescription.version})\n${selfDescription.content}` : '(missing)'),
    section('OPERATING NOTES (last 4 versions, newest first)', notes.length
      ? notes.map(n => `### v${n.version} (${n.created_at})\n${n.content}`).join('\n\n')
      : '(none yet)'),
    header('meta'),
    section(`METRICS (last ${metrics.window_days} days vs the ${metrics.window_days} before)`, JSON.stringify(metrics, null, 2)),
    section('ALL PROPOSALS (oldest first, with verdicts)', proposals.length
      ? JSON.stringify(proposals.map(p => ({
        id: p.id, created_at: p.created_at, category: p.category, direction: p.direction, title: p.title, body: p.body,
        evidence: p.evidence, supersedes: p.supersedes, verdict: p.verdict, verdict_reason: p.verdict_reason, verdict_at: p.verdict_at,
      })), null, 2)
      : '(none yet)'),
    section('REFLECTION ENTRIES (last 7)', renderForContext(lastBlocks(reflections, 7))),
    section('DAY LOGS (last 7 closed days)', renderForContext(lastBlocks(daylogs, 7))),
    section('ACTIVE ITEMS (titles and status only)', active.length
      ? active.map(a => `- [${a.status}] ${a.title}`).join('\n')
      : '(none)'),
  ].join('\n\n')
  return [{ role: 'user', text: context }]
}
