import { createAdminClient } from '@/lib/supabase/admin'
import { SYSTEM_PROMPT } from './systemPrompt'
import { readLatest, readRange, readCurrent, renderForContext } from './files'
import { addDays, describeNow, localDate, reflectionDay, startOfLocalDay } from './time'
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

type LogRow = { direction: string; call_type: string; content: string; created_at: string }

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

function renderActive(items: ActiveItem[]): string {
  return items.length ? JSON.stringify(items, null, 2) : '(none)'
}

function renderLog(rows: LogRow[]): string {
  return rows.map(r => `[${r.created_at}] ${r.direction === 'in' ? 'USER' : `DAEMON(${r.call_type})`}: ${r.content}`).join('\n')
}

function header(callType: string): string {
  return `${describeNow()}\nCall type: ${callType}. Respond only with JSON matching the response schema.`
}

export async function buildInputTurns(userId: string, messages: string[]): Promise<Turn[]> {
  const now = new Date()
  const today = localDate(now)
  const admin = createAdminClient()
  const [active, reflections, calendar, log] = await Promise.all([
    loadActive(userId),
    readRange(userId, 'reflection', addDays(today, -3), today, today),
    readRange(userId, 'calendar', today, addDays(today, 7), today),
    admin.from('daemon_interaction_log')
      .select('direction, call_type, content, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20 + messages.length),
  ])
  if (log.error) throw new Error(`interaction log read failed: ${log.error.message}`)
  // The messages being answered were logged on receipt; don't show them twice.
  const pending = [...messages]
  const history = ((log.data ?? []) as LogRow[]).reverse().filter(r => {
    const i = r.direction === 'in' ? pending.indexOf(r.content) : -1
    if (i === -1) return true
    pending.splice(i, 1)
    return false
  }).slice(-20)

  const context = [
    header('input'),
    section('ACTIVE ITEMS', renderActive(active)),
    section('REFLECTION LOG (last 3 days)', renderForContext(reflections)),
    section('CALENDAR (today + 7 days)', renderForContext(calendar)),
    section('RECENT INTERACTIONS', renderLog(history)),
    messages.length > 1 ? `The user sent ${messages.length} messages, in order, as the following turns.` : 'The user\'s message follows.',
  ].join('\n\n')

  return [{ role: 'user', text: context }, ...messages.map(m => ({ role: 'user' as const, text: m }))]
}

export async function buildHeartbeatTurns(userId: string): Promise<Turn[]> {
  const today = localDate()
  const [active, lastReflection, calendar] = await Promise.all([
    loadActive(userId),
    readLatest(userId, 'reflection'),
    readRange(userId, 'calendar', today, today, today),
  ])
  const context = [
    header('heartbeat'),
    section('ACTIVE ITEMS', renderActive(active)),
    section('LATEST REFLECTION', lastReflection ? renderForContext([lastReflection]) : '(none yet)'),
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
  const admin = createAdminClient()
  const [active, reflections, calendar, log] = await Promise.all([
    loadActive(userId),
    readRange(userId, 'reflection', addDays(day, -7), day, today),
    readCurrent(userId, 'calendar'),
    admin.from('daemon_interaction_log')
      .select('direction, call_type, content, created_at')
      .eq('user_id', userId)
      .gte('created_at', dayStart.toISOString())
      .order('created_at', { ascending: true })
      .limit(500),
  ])
  if (log.error) throw new Error(`interaction log read failed: ${log.error.message}`)
  const logRows = (log.data ?? []) as LogRow[]
  const archive = await matchArchive(userId, active, logRows.map(r => r.content).join('\n'))

  const context = [
    header('reflection'),
    `Reflecting on ${day}. Write todays_log and calendar_roll for ${day}; tomorrow_plan is for ${addDays(day, 1)}.`,
    section('ACTIVE ITEMS', renderActive(active)),
    section('RELEVANT ARCHIVE (tag-matched)', archive.length ? JSON.stringify(archive, null, 2) : '(none)'),
    section('REFLECTION LOG (last 7 days)', renderForContext(reflections)),
    section(`INTERACTIONS (${day})`, renderLog(logRows)),
    section('CALENDAR (current month)', calendar),
  ].join('\n\n')
  return [{ role: 'user', text: context }]
}
