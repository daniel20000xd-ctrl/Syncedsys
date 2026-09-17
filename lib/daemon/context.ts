import { createAdminClient } from '@/lib/supabase/admin'
import { SYSTEM_PROMPT } from './systemPrompt'
import { readLatest, readRange, readCurrent, renderForContext } from './files'
import { addDays, describeNow, localDate, reflectionDay, startOfLocalDay } from './time'
import { getLatestNotes } from './notes'
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

export const system = () => SYSTEM_PROMPT

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

export async function buildInputTurns(userId: string, threadId: string, messages: string[]): Promise<Turn[]> {
  const today = localDate()
  await ensureDaylogMigrated(userId)
  const admin = createAdminClient()
  const [headSections, active, daylogs, calendar, log] = await Promise.all([
    head(userId, today, { id: threadId, excludeInbound: messages }),
    loadActive(userId),
    readRange(userId, 'daylog', addDays(today, -3), addDays(today, -1), today),
    readRange(userId, 'calendar', today, addDays(today, 7), today),
    admin.from('daemon_interaction_log')
      .select('direction, call_type, content, created_at, thread_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(40),
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

const STOPWORDS = new Set(['that', 'this', 'with', 'have', 'from', 'what', 'when', 'will', 'just', 'your', 'about', 'there', 'they', 'would', 'could', 'should', 'been', 'were', 'into', 'then', 'than', 'them', 'also', 'some', 'like'])

// Tag/keyword overlap retrieval. Seam for embedding-based retrieval later: swap this
// function's body for a vector search over daemon_archive and keep the signature.
async function matchArchive(userId: string, active: ActiveItem[], interactionText: string): Promise<ArchiveItem[]> {
  const terms = new Set<string>()
  for (const item of active) for (const t of item.tags) terms.add(t.trim().toLowerCase())
  for (const w of interactionText.toLowerCase().match(/[a-z0-9åäöæøéèüß_-]{4,}/g) ?? []) {
    if (!STOPWORDS.has(w)) terms.add(w)
  }
  const list = [...terms].filter(Boolean).slice(0, 300)
  if (!list.length) return []
  const { data, error } = await createAdminClient()
    .from('daemon_archive')
    .select('*')
    .eq('user_id', userId)
    .overlaps('tags', list)
    .order('archived_at', { ascending: false })
    .limit(30)
  if (error) throw new Error(`daemon_archive read failed: ${error.message}`)
  return (data ?? []) as ArchiveItem[]
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
      .gte('created_at', dayStart.toISOString())
      .order('created_at', { ascending: true })
      .limit(500),
    loadDayEntries(userId, day),
  ])
  if (log.error) throw new Error(`interaction log read failed: ${log.error.message}`)
  const logRows = (log.data ?? []) as LogRow[]
  const archive = await matchArchive(userId, active, [...logRows, ...entries].map(r => r.content).join('\n'))

  const context = [
    ...headSections,
    header('reflection'),
    `Reflecting on ${day}. day_log_close and calendar_roll are for ${day}; tomorrow_plan is for ${addDays(day, 1)}. operating_notes replaces the current version in full.`,
    section('ACTIVE ITEMS', await renderWithLinks(userId, active)),
    section('RELEVANT ARCHIVE (tag-matched)', await renderWithLinks(userId, archive)),
    section('UNCLOSED THREADS', threads),
    section('DAY LOG (previous 7 days)', renderForContext(daylogs)),
    section(`INTERACTIONS (${day})`, renderLog(logRows)),
    section('CALENDAR (current month)', calendar),
  ].join('\n\n')
  return [{ role: 'user', text: context }]
}
