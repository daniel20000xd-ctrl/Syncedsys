import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { loadDayEntries, renderDayEntries } from './daylog'
import type { ThreadState } from './schemas'
import { renderHits, type SearchHit } from './search'

// A thread holds references, not a snapshot: referenced items are re-resolved fresh
// every time the thread is loaded. Routing to threads is deterministic, never model-classified.

export type ThreadStatus = 'open' | 'answered' | 'closed'

export type Thread = {
  id: string
  user_id: string
  opened_by: 'ai' | 'me'
  topic: string
  question: string | null
  reasoning: string | null
  referenced_active_ids: string[]
  referenced_archive_ids: string[]
  referenced_log_dates: string[]
  expects_reply: boolean
  status: ThreadStatus
  opened_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: string | null
  working_state: string | null
  open_question: string | null
}

export type Finding = { id: string; query: string; why: string | null; results: SearchHit[]; created_at: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOPIC_PLACEHOLDER_MAX = 80
const MAX_THREAD_MESSAGES = 60
const MAX_LOG_DATES = 3
const MAX_REFERENCES = 30

const union = (a: string[], b: string[]) => [...new Set([...a, ...b.filter(id => UUID.test(id))])].slice(-MAX_REFERENCES)

export function placeholderTopic(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length <= TOPIC_PLACEHOLDER_MAX ? flat : `${flat.slice(0, TOPIC_PLACEHOLDER_MAX - 1).trimEnd()}…`
}

export async function createThread(userId: string, t: {
  openedBy: 'ai' | 'me'
  topic: string
  question?: string | null
  reasoning?: string | null
  activeIds?: string[]
  archiveIds?: string[]
  logDates?: string[]
  expectsReply?: boolean
  workingState?: string | null
  openQuestion?: string | null
}): Promise<Thread> {
  const now = new Date().toISOString()
  const { data, error } = await createAdminClient().from('daemon_threads').insert({
    user_id: userId,
    opened_by: t.openedBy,
    topic: t.topic,
    question: t.question ?? null,
    reasoning: t.reasoning ?? null,
    referenced_active_ids: (t.activeIds ?? []).filter(id => UUID.test(id)),
    referenced_archive_ids: (t.archiveIds ?? []).filter(id => UUID.test(id)),
    referenced_log_dates: t.logDates ?? [],
    expects_reply: t.expectsReply ?? false,
    working_state: t.workingState ?? null,
    open_question: t.openQuestion ?? null,
    status: 'open',
    opened_at: now,
    last_activity_at: now,
  }).select('*').single()
  if (error) throw new Error(`thread create failed: ${error.message}`)
  return data as Thread
}

export async function getThread(userId: string, id: string): Promise<Thread | null> {
  if (!UUID.test(id)) return null
  const { data, error } = await createAdminClient()
    .from('daemon_threads').select('*').eq('user_id', userId).eq('id', id).maybeSingle()
  if (error) throw new Error(`thread read failed: ${error.message}`)
  return data as Thread | null
}

// A reply from the user. Replying to a closed thread reopens it.
export async function markThreadReplied(threadId: string): Promise<void> {
  const { error } = await createAdminClient().from('daemon_threads').update({
    status: 'answered', last_activity_at: new Date().toISOString(), closed_at: null, close_reason: null,
  }).eq('id', threadId)
  if (error) throw new Error(`thread update failed: ${error.message}`)
}

export async function updateThreadAfterInput(threadId: string, u: {
  status: 'answered' | 'open'
  expectsReply: boolean
  topic?: string | null
  state: ThreadState
}): Promise<void> {
  const admin = createAdminClient()
  const { data: current } = await admin.from('daemon_threads')
    .select('referenced_active_ids, referenced_archive_ids').eq('id', threadId).maybeSingle()
  await admin.from('daemon_threads').update({
    status: u.status,
    expects_reply: u.expectsReply,
    last_activity_at: new Date().toISOString(),
    working_state: u.state.working_state,
    open_question: u.state.open_question,
    referenced_active_ids: union(current?.referenced_active_ids ?? [], u.state.referenced_active_ids),
    referenced_archive_ids: union(current?.referenced_archive_ids ?? [], u.state.referenced_archive_ids),
    ...(u.topic?.trim() ? { topic: u.topic.trim() } : {}),
  }).eq('id', threadId)
  // The user has spoken on this thread, so whatever it was waiting on has been reported.
  await clearAwaitingReport(threadId)
}

// A heartbeat pinging into an existing thread: the daemon spoke last, so the thread is open.
export async function updateThreadFromHeartbeat(thread: Thread, state: ThreadState, expectsReply: boolean): Promise<void> {
  await createAdminClient().from('daemon_threads').update({
    status: 'open',
    expects_reply: expectsReply,
    last_activity_at: new Date().toISOString(),
    closed_at: null,
    close_reason: null,
    working_state: state.working_state,
    open_question: state.open_question,
    referenced_active_ids: union(thread.referenced_active_ids, state.referenced_active_ids),
    referenced_archive_ids: union(thread.referenced_archive_ids, state.referenced_archive_ids),
  }).eq('id', thread.id)
}

// ── findings: model-requested searches, delivered on the next call in the thread ──

export async function addFinding(userId: string, threadId: string, query: string, why: string, results: SearchHit[]): Promise<void> {
  const { error } = await createAdminClient().from('daemon_thread_findings')
    .insert({ user_id: userId, thread_id: threadId, query, why, results })
  if (error) console.error('[daemon/threads] finding insert failed:', error.message)
}

export async function pendingFindings(threadIds: string[]): Promise<Map<string, Finding[]>> {
  const out = new Map<string, Finding[]>()
  if (!threadIds.length) return out
  const { data, error } = await createAdminClient().from('daemon_thread_findings')
    .select('id, thread_id, query, why, results, created_at')
    .in('thread_id', threadIds).is('consumed_at', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`findings read failed: ${error.message}`)
  for (const f of (data ?? []) as (Finding & { thread_id: string })[]) out.set(f.thread_id, [...(out.get(f.thread_id) ?? []), f])
  return out
}

// Marked only after the call that saw them succeeded, so a failed call never loses them.
export async function consumeFindings(ids: string[], by: 'input' | 'heartbeat'): Promise<void> {
  if (!ids.length) return
  await createAdminClient().from('daemon_thread_findings')
    .update({ consumed_at: new Date().toISOString(), consumed_by: by })
    .in('id', ids).is('consumed_at', null)
}

export function renderFindings(findings: Finding[]): string {
  return findings.map(f => {
    const hits = f.results.length ? renderHits(f.results) : '(nothing cleared the relevance threshold)'
    return `You searched for "${f.query}" (${f.created_at.slice(0, 16)}${f.why ? `, because: ${f.why}` : ''}):\n${hits}`
  }).join('\n\n')
}

export async function clearAwaitingReport(threadId: string): Promise<void> {
  await createAdminClient().from('daemon_active')
    .update({ awaiting_report_thread_id: null, awaiting_report_since: null })
    .eq('awaiting_report_thread_id', threadId)
}

export async function closeThread(userId: string, threadId: string, reason: string): Promise<boolean> {
  if (!UUID.test(threadId)) return false
  const { data, error } = await createAdminClient().from('daemon_threads')
    .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: reason })
    .eq('user_id', userId).eq('id', threadId).neq('status', 'closed')
    .select('id')
  if (error) {
    console.error('[daemon/threads] close failed:', error.message)
    return false
  }
  if (data?.length) await clearAwaitingReport(threadId)
  return !!data?.length
}

// Backstop so dangling questions don't accumulate when reflection doesn't close them.
export async function closeStaleThreads(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - daemonEnv.threadStaleDays() * 86_400_000).toISOString()
  const { data, error } = await createAdminClient().from('daemon_threads')
    .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: 'stale' })
    .eq('user_id', userId).eq('status', 'open').lt('last_activity_at', cutoff)
    .select('id')
  if (error) {
    console.error('[daemon/threads] stale close failed:', error.message)
    return 0
  }
  for (const t of data ?? []) await clearAwaitingReport(t.id)
  return data?.length ?? 0
}

export async function listUnclosedThreads(userId: string, limit = 50): Promise<Thread[]> {
  const { data, error } = await createAdminClient().from('daemon_threads')
    .select('*').eq('user_id', userId).neq('status', 'closed')
    .order('last_activity_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`threads read failed: ${error.message}`)
  return (data ?? []) as Thread[]
}

export async function latestMessages(threadIds: string[]): Promise<Map<string, { direction: string; content: string; created_at: string }>> {
  const out = new Map<string, { direction: string; content: string; created_at: string }>()
  if (!threadIds.length) return out
  const { data, error } = await createAdminClient().rpc('daemon_thread_previews', { thread_ids: threadIds })
  if (error) throw new Error(`thread previews failed: ${error.message}`)
  for (const r of (data ?? []) as { thread_id: string; direction: string; content: string; created_at: string }[]) {
    out.set(r.thread_id, r)
  }
  return out
}

// One line per unclosed thread, with who spoke last — lets a heartbeat see "asked 4h
// ago, no reply" as a fact.
export async function renderThreadSummaries(userId: string, limit = 30): Promise<string> {
  const threads = await listUnclosedThreads(userId, limit)
  if (!threads.length) return '(none)'
  const [last, findings] = await Promise.all([latestMessages(threads.map(t => t.id)), pendingFindings(threads.map(t => t.id))])
  const hours = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 360_000) / 10
  return threads.map(t => {
    const l = last.get(t.id)
    const f = findings.get(t.id)
    const stub = JSON.stringify({
      id: t.id, topic: t.topic, opened_by: t.opened_by, status: t.status, expects_reply: t.expects_reply,
      question: t.question, open_question: t.open_question,
      age_hours: hours(t.opened_at), hours_since_activity: hours(t.last_activity_at),
      last_message_from: l ? (l.direction === 'in' ? 'user' : 'daemon') : null,
      pending_findings: f?.length ?? 0,
    })
    return f?.length ? `${stub}\n${renderFindings(f)}` : stub
  }).join('\n')
}

// Thread row + its messages + the referenced items re-resolved now.
// `excludeInbound`: messages being answered in this call, which are sent as their own
// turns and shouldn't appear twice.
export async function buildThreadContext(userId: string, threadId: string, today: string, excludeInbound: string[] = []): Promise<string> {
  const thread = await getThread(userId, threadId)
  if (!thread) return '(thread not found)'
  const admin = createAdminClient()
  const [messages, active, archive, findings] = await Promise.all([
    admin.from('daemon_interaction_log')
      .select('direction, call_type, content, created_at, reasoning')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(MAX_THREAD_MESSAGES),
    thread.referenced_active_ids.length
      ? admin.from('daemon_active').select('id, type, title, content, status, deadline, tags, last_nudged_at, awaiting_report_since').in('id', thread.referenced_active_ids)
      : Promise.resolve({ data: [] }),
    thread.referenced_archive_ids.length
      ? admin.from('daemon_archive').select('id, type, title, content, tags, outcome, why_archived, archived_at').in('id', thread.referenced_archive_ids)
      : Promise.resolve({ data: [] }),
    pendingFindings([threadId]),
  ])

  const logDates = thread.referenced_log_dates.filter(d => d !== today).sort().slice(-MAX_LOG_DATES)
  const logs = await Promise.all(logDates.map(async d => {
    const rendered = renderDayEntries(await loadDayEntries(userId, d))
    return rendered ? `#### ${d}\n${rendered}` : ''
  }))

  const activeFound = new Set((active.data ?? []).map((a: { id: string }) => a.id))
  const gone = thread.referenced_active_ids.filter(id => !activeFound.has(id))
  const { data: archivedSince } = gone.length
    ? await admin.from('daemon_archive').select('id, original_id, title, outcome, why_archived, archived_at').in('original_id', gone)
    : { data: [] }
  const { reasoning, working_state, open_question, ...rest } = thread
  const meta: Record<string, unknown> = { ...rest }
  delete meta.user_id
  const threadFindings = findings.get(threadId) ?? []
  const pending = [...excludeInbound]
  const shown = ((messages.data ?? []) as { direction: string; call_type: string; content: string; created_at: string; reasoning: string | null }[])
    .filter(m => {
      const i = m.direction === 'in' ? pending.indexOf(m.content) : -1
      if (i === -1) return true
      pending.splice(i, 1)
      return false
    })
    .reverse()

  return [
    `Thread: ${JSON.stringify(meta)}`,
    reasoning ? `Why it was opened (internal, never shown to the user): ${reasoning}` : '',
    `Your working state on this thread (from your last turn):\n${working_state?.trim() || '(none yet)'}`,
    `Your open question: ${open_question?.trim() || '(none)'}`,
    `Messages in this thread (oldest first; your reasoning in [why: …] was never shown to the user):\n${shown
      .map(m => `[${m.created_at}] ${m.direction === 'in' ? 'USER' : `DAEMON(${m.call_type})`}: ${m.content}${m.reasoning ? `\n  [why: ${m.reasoning}]` : ''}`)
      .join('\n') || '(none)'}`,
    threadFindings.length ? `Results of searches you asked for on this thread (new since your last turn):\n${renderFindings(threadFindings)}` : '',
    `Referenced active items, current state:\n${active.data?.length ? JSON.stringify(active.data, null, 2) : '(none)'}`,
    gone.length ? `Referenced items no longer active: ${gone.join(', ')}` : '',
    archivedSince?.length ? `Of those, archived since:\n${JSON.stringify(archivedSince, null, 2)}` : '',
    archive.data?.length ? `Referenced archive items:\n${JSON.stringify(archive.data, null, 2)}` : '',
    logs.filter(Boolean).length ? `Referenced day logs:\n${logs.filter(Boolean).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}
