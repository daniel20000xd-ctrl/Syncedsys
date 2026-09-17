'use server'

// Daemon admin console: every read and the narrow write set behind /daemon.
//
// Deliberately NOT in app/actions.ts (the repo's usual home for server actions): the
// daemon is an isolated subsystem, and this file is the only place prompts, the
// self-description, model routing (daemon_model_config) and model prices
// (daemon_model_prices) are written. Nothing in lib/daemon/ or app/api/daemon/ may
// import this file — the daemon's runtime has no path to its own prompts, and no path
// to picking its own model or setting its own prices.
//
// Every export is a public server action, so every export re-checks isAdminEmail
// server-side. Memory surfaces are read-only here by design: the operator changes the
// daemon's memory by messaging it, never by editing rows.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdminEmail } from '@/lib/admin'
import { getDaemonUserId, getState } from '@/lib/daemon/state'
import { daemonEnv } from '@/lib/daemon/env'
import { localDate, startOfLocalDay } from '@/lib/daemon/time'
import { loadDayEntries } from '@/lib/daemon/daylog'
import { loadLinkStubs, type LinkStub } from '@/lib/daemon/links'
import { computeMetrics } from '@/lib/daemon/metrics'
import { listFamilyFiles, readMonth, type Family } from '@/lib/daemon/files'
import { invalidatePriceCache, todaysSpendUsd } from '@/lib/daemon/usage'
import { metaJob, reflectionJob, schedulerTick } from '@/lib/daemon/jobs'
import { debugAllowed, dryRun } from '@/lib/daemon/dryrun'
import type { PromptKind } from '@/lib/daemon/prompts'
import type { CallType } from '@/lib/daemon/gemini'
import { DEFAULT_MIN_SCORE, PREFETCH_MIN_SCORE, SEARCH_KINDS, searchMemoryMany, type SearchKind } from '@/lib/daemon/search'
import { vectorStatus } from '@/lib/daemon/embeddings'
import { invalidateModelCache, peekModelFor, type ModelKind } from '@/lib/daemon/models'

const PROMPT_KINDS: PromptKind[] = ['system', 'input', 'heartbeat', 'reflection', 'meta']
const CALL_TYPES: CallType[] = ['input', 'heartbeat', 'reflection', 'meta']
const FAMILIES: Family[] = ['daylog', 'reflections', 'calendar']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requireAdmin(): Promise<string> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) throw new Error('forbidden')
  return user.email!
}

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

// Operator actions share the timeline with the daemon's own messages.
async function logOperatorAction(userId: string, content: string): Promise<void> {
  const { error } = await createAdminClient().from('daemon_interaction_log')
    .insert({ user_id: userId, direction: 'in', call_type: 'system', content: `[operator] ${content}` })
  if (error) console.error('[daemonActions] operator log failed:', error.message)
}

// ── identity ─────────────────────────────────────────────────────────────────────

export async function getAdminAccess(): Promise<{ signedIn: boolean; admin: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { signedIn: !!user, admin: !!user && isAdminEmail(user.email) }
}

// ── overview ─────────────────────────────────────────────────────────────────────

export async function getOverview() {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  const today = localDate()
  const [state, spend, entries, threads, proposals, pendingOutbound] = await Promise.all([
    getState(),
    todaysSpendUsd(),
    loadDayEntries(userId, today),
    admin.from('daemon_threads').select('id, topic, question, opened_by, expects_reply, status, opened_at, last_activity_at')
      .eq('user_id', userId).eq('status', 'open').order('last_activity_at', { ascending: false }).limit(50),
    admin.from('daemon_proposals').select('id, category, direction, title, created_at')
      .eq('user_id', userId).eq('verdict', 'open').order('created_at', { ascending: false }),
    admin.from('daemon_pending_outbound').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('delivered_at', null),
  ])
  const lockAgeSeconds = state.lock_acquired_at ? Math.round((Date.now() - Date.parse(state.lock_acquired_at)) / 1000) : null
  return {
    state,
    lock: {
      held: state.is_processing,
      holder: state.holder,
      acquiredAt: state.lock_acquired_at,
      ageSeconds: lockAgeSeconds,
      timeoutSeconds: daemonEnv.lockTimeoutSeconds(),
      stale: state.is_processing && lockAgeSeconds !== null && lockAgeSeconds > daemonEnv.lockTimeoutSeconds(),
    },
    cost: { todayUsd: spend.totalUsd, unknownCostCalls: spend.unknownCount, capUsd: daemonEnv.dailyCostCapUsd() },
    today,
    dayEntries: entries,
    openThreads: must(threads, 'threads'),
    openProposals: must(proposals, 'proposals'),
    pendingOutbound: pendingOutbound.count ?? 0,
    debugAllowed: debugAllowed(),
    wakeHours: { wake: daemonEnv.wakeHour(), sleep: daemonEnv.sleepHour(), tz: daemonEnv.tz() },
  }
}

// ── operator controls ────────────────────────────────────────────────────────────

export async function setShadowMode(on: boolean): Promise<void> {
  const email = await requireAdmin()
  const userId = await getDaemonUserId()
  const now = new Date().toISOString()
  must(await createAdminClient().from('daemon_state').update({ shadow_mode: on, updated_at: now }).eq('id', 1).select('id'), 'shadow mode')
  await logOperatorAction(userId, `shadow mode turned ${on ? 'ON' : 'OFF'} by ${email}`)
  revalidatePath('/daemon')
}

export async function setEnabled(on: boolean): Promise<void> {
  const email = await requireAdmin()
  const userId = await getDaemonUserId()
  const now = new Date().toISOString()
  must(await createAdminClient().from('daemon_state').update({ enabled: on, updated_at: now }).eq('id', 1).select('id'), 'enabled')
  await logOperatorAction(userId, `daemon ${on ? 'ENABLED' : 'DISABLED (kill switch)'} by ${email}`)
  revalidatePath('/daemon')
}

// Same gate and the same job functions as POST /api/daemon/debug/run.
export async function triggerCall(type: 'heartbeat' | 'reflection' | 'meta'): Promise<{ status: number; body: Record<string, unknown> }> {
  const email = await requireAdmin()
  if (!debugAllowed()) throw new Error('manual triggers are disabled in production (set DAEMON_DEBUG_ENABLED=true)')
  if (!['heartbeat', 'reflection', 'meta'].includes(type)) throw new Error('invalid call type')
  const userId = await getDaemonUserId()
  const shadow = (await getState()).shadow_mode
  await logOperatorAction(userId, `manual ${type} triggered by ${email} (shadow mode ${shadow ? 'on' : 'off'})`)
  const result = type === 'heartbeat'
    ? await schedulerTick({ force: true })
    : type === 'reflection' ? await reflectionJob({ force: true }) : await metaJob({ force: true })
  await logOperatorAction(userId, `manual ${type} finished: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`)
  revalidatePath('/daemon')
  return result
}

export async function forceReleaseLock(): Promise<{ released: boolean; reason?: string }> {
  const email = await requireAdmin()
  const userId = await getDaemonUserId()
  const state = await getState()
  const age = state.lock_acquired_at ? (Date.now() - Date.parse(state.lock_acquired_at)) / 1000 : null
  if (!state.is_processing || age === null) return { released: false, reason: 'lock is not held' }
  if (age <= daemonEnv.lockTimeoutSeconds()) return { released: false, reason: `lock is only ${Math.round(age)}s old (stale after ${daemonEnv.lockTimeoutSeconds()}s)` }
  const res = must(await createAdminClient().from('daemon_state')
    .update({ is_processing: false, holder: null, lock_acquired_at: null, updated_at: new Date().toISOString() })
    .eq('id', 1).eq('lock_acquired_at', state.lock_acquired_at).select('id'), 'lock release')
  if (!res.length) return { released: false, reason: 'lock changed in the meantime' }
  await logOperatorAction(userId, `force-released stale lock held by ${state.holder} for ${Math.round(age)}s (by ${email})`)
  revalidatePath('/daemon')
  return { released: true }
}

// ── proposals ────────────────────────────────────────────────────────────────────

export async function getProposals() {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const rows = must(await createAdminClient().from('daemon_proposals').select('*')
    .eq('user_id', userId).order('created_at', { ascending: false }), 'proposals')
  return rows as {
    id: string; cycle_at: string; category: string; direction: string; title: string; body: string
    evidence: Record<string, unknown>; verdict: string; verdict_reason: string | null; verdict_at: string | null
    supersedes: string | null; created_at: string
  }[]
}

// Writes only verdict, verdict_reason and verdict_at — the same columns as the message path.
export async function recordVerdict(proposalId: string, verdict: 'accepted' | 'rejected' | 'implemented', reason: string): Promise<void> {
  const email = await requireAdmin()
  if (!UUID.test(proposalId)) throw new Error('invalid proposal id')
  if (!['accepted', 'rejected', 'implemented'].includes(verdict)) throw new Error('invalid verdict')
  if (!reason.trim()) throw new Error('a reason is required')
  const userId = await getDaemonUserId()
  const res = must(await createAdminClient().from('daemon_proposals')
    .update({ verdict, verdict_reason: reason.trim(), verdict_at: new Date().toISOString() })
    .eq('user_id', userId).eq('id', proposalId).select('title'), 'verdict')
  if (!res.length) throw new Error('proposal not found')
  await logOperatorAction(userId, `verdict ${verdict} on proposal "${res[0].title}" by ${email}: ${reason.trim()}`)
  revalidatePath('/daemon/proposals')
  revalidatePath('/daemon')
}

// ── prompts & self-description ───────────────────────────────────────────────────

export type PromptTab = PromptKind | 'self_description'

export async function getPromptVersions(tab: PromptTab) {
  await requireAdmin()
  const admin = createAdminClient()
  if (tab === 'self_description') {
    const rows = must(await admin.from('daemon_self_description').select('version, content, note, created_at')
      .order('version', { ascending: false }), 'self-description') as { version: number; content: string; note: string | null; created_at: string }[]
    return rows.map((r, i) => ({ ...r, is_active: i === 0 }))
  }
  if (!PROMPT_KINDS.includes(tab)) throw new Error('invalid prompt kind')
  return must(await admin.from('daemon_prompts').select('version, content, note, created_at, is_active')
    .eq('kind', tab).order('version', { ascending: false }), 'prompts') as
    { version: number; content: string; note: string | null; created_at: string; is_active: boolean }[]
}

// Publishing inserts a new version and flips is_active in one transaction (SQL
// function). Rows are never updated in content or deleted.
export async function publishPrompt(tab: PromptTab, content: string, note: string): Promise<{ version: number }> {
  const email = await requireAdmin()
  if (!content.trim()) throw new Error('content must not be empty')
  if (!note.trim()) throw new Error('a note is required')
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  let version: number
  if (tab === 'self_description') {
    const row = must(await admin.rpc('daemon_publish_self_description', { p_content: content, p_note: note.trim(), p_user_id: userId }), 'publish') as { version: number }
    version = row.version
  } else {
    if (!PROMPT_KINDS.includes(tab)) throw new Error('invalid prompt kind')
    const row = must(await admin.rpc('daemon_publish_prompt', { p_kind: tab, p_content: content, p_note: note.trim(), p_user_id: userId }), 'publish') as { version: number }
    version = row.version
  }
  await logOperatorAction(userId, `published ${tab} v${version} by ${email}: ${note.trim()}`)
  revalidatePath('/daemon/prompts')
  return { version }
}

// Revert = publish a copy of an old version's content as a new version.
export async function revertPrompt(tab: PromptTab, fromVersion: number, note: string): Promise<{ version: number }> {
  await requireAdmin()
  const versions = await getPromptVersions(tab)
  const source = versions.find(v => v.version === fromVersion)
  if (!source) throw new Error(`version ${fromVersion} not found`)
  return publishPrompt(tab, source.content, `revert to v${fromVersion}: ${note.trim() || '(no note)'}`)
}

// A draft is sent through the same dry-run path as the debug route: real context, no
// persistence, no notification, the draft never stored.
export async function dryRunPrompt(input: { tab: PromptTab; content: string; callType: CallType; message?: string }) {
  await requireAdmin()
  if (!debugAllowed()) throw new Error('dry runs are disabled in production (set DAEMON_DEBUG_ENABLED=true)')
  if (!CALL_TYPES.includes(input.callType)) throw new Error('invalid call type')
  if (!input.content.trim()) throw new Error('draft is empty')
  if (input.tab === 'self_description') {
    // The self-description is data, not a prompt kind; it's only read by the meta call,
    // which loads the stored version. Dry-run the stored prompts instead.
    throw new Error('dry runs apply to prompts; the meta call reads the published self-description')
  }
  return dryRun({ callType: input.callType, override: { kind: input.tab, content: input.content }, message: input.message })
}

// ── operating notes ──────────────────────────────────────────────────────────────

export async function getNotesVersions() {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const rows = must(await createAdminClient().from('daemon_operating_notes').select('version, content, created_at')
    .eq('user_id', userId).order('version', { ascending: false }), 'notes') as { version: number; content: string; created_at: string }[]
  return { versions: rows, maxChars: daemonEnv.notesMaxChars() }
}

// ── memory ───────────────────────────────────────────────────────────────────────

export type MemoryFilters = { q?: string; tag?: string; type?: string; status?: string; item?: string }

type ActiveRow = {
  id: string; type: string; title: string; content: string; status: string; deadline: string | null; tags: string[]
  reschedule_count: number; last_nudged_at: string | null; awaiting_report_since: string | null; created_at: string; last_touched: string
}
type ArchiveRow = {
  id: string; original_id: string | null; type: string; title: string; content: string; tags: string[]
  outcome: string | null; why_archived: string | null; depth: number; archived_at: string; created_at: string
}
type MemoryEvent = { item_id: string; event: string; call_type: string | null; why: string | null; outcome: string | null; created_at: string }

const escapeLike = (s: string) => s.replace(/[\\%_,()]/g, c => `\\${c}`)

export async function getMemory(filters: MemoryFilters) {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  let active = admin.from('daemon_active').select('*').eq('user_id', userId)
  let archive = admin.from('daemon_archive').select('*').eq('user_id', userId)
  if (filters.q?.trim()) {
    const q = escapeLike(filters.q.trim())
    active = active.or(`title.ilike.%${q}%,content.ilike.%${q}%`)
    archive = archive.or(`title.ilike.%${q}%,content.ilike.%${q}%,outcome.ilike.%${q}%`)
  }
  if (filters.tag?.trim()) {
    active = active.contains('tags', [filters.tag.trim().toLowerCase()])
    archive = archive.contains('tags', [filters.tag.trim().toLowerCase()])
  }
  if (filters.type) {
    active = active.eq('type', filters.type)
    archive = archive.eq('type', filters.type)
  }
  if (filters.status) active = active.eq('status', filters.status)
  // One lineage: the active item and every archived incarnation of it (by either id).
  if (filters.item && UUID.test(filters.item)) {
    const { data: hit } = await admin.from('daemon_archive').select('original_id').eq('id', filters.item).maybeSingle()
    const lineage = hit?.original_id ?? filters.item
    active = active.eq('id', lineage)
    archive = archive.or(`id.eq.${filters.item},original_id.eq.${lineage}`)
  }

  const [activeRes, archiveRes] = await Promise.all([
    active.order('last_touched', { ascending: false }).limit(300),
    archive.order('archived_at', { ascending: false }).limit(300),
  ])
  const activeRows = must(activeRes, 'active') as ActiveRow[]
  // Status applies to active items only; archived items have none.
  const archiveRows = filters.status ? [] : must(archiveRes, 'archive') as ArchiveRow[]

  const lineage = [...new Set([...activeRows.map(a => a.id), ...archiveRows.map(a => a.original_id).filter((x): x is string => !!x)])]
  const [stubs, events] = await Promise.all([
    loadLinkStubs(userId, [...activeRows.map(a => a.id), ...archiveRows.map(a => a.id)]),
    lineage.length
      ? admin.from('daemon_memory_events').select('item_id, event, call_type, why, outcome, created_at')
        .in('item_id', lineage).order('created_at', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ])
  const eventsByItem: Record<string, MemoryEvent[]> = {}
  for (const e of must(events, 'memory events') as MemoryEvent[]) (eventsByItem[e.item_id] ??= []).push(e)
  const stubsById: Record<string, LinkStub[]> = Object.fromEntries(stubs)

  const allTags = [...new Set([...activeRows, ...archiveRows].flatMap(r => r.tags))].sort()
  return { active: activeRows, archive: archiveRows, stubs: stubsById, events: eventsByItem, tags: allTags }
}

// Runs searchMemory directly so retrieval quality can be checked by hand. Read-only: no
// recall event is logged, so console searches don't skew the recall metrics.
export async function searchMemoryConsole(query: string, opts: { kinds?: string[]; minScore?: number; limit?: number }) {
  await requireAdmin()
  const kinds = (opts.kinds ?? []).filter((k): k is SearchKind => (SEARCH_KINDS as readonly string[]).includes(k))
  const { hits, signals } = await searchMemoryMany([query], {
    kinds: kinds.length ? kinds : SEARCH_KINDS,
    minScore: Math.max(0, Math.min(1, opts.minScore ?? 0)),
    limit: Math.min(Math.max(opts.limit ?? 25, 1), 100),
  })
  return { hits, signals, vector: await vectorStatus(), thresholds: { default: DEFAULT_MIN_SCORE, prefetch: PREFETCH_MIN_SCORE } }
}

// ── graph ────────────────────────────────────────────────────────────────────────

export async function getGraph(limit: number) {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  const cap = Math.min(Math.max(limit, 25), 2000)
  const [active, archive, activeCount, archiveCount] = await Promise.all([
    admin.from('daemon_active').select('id, title, status, type, last_touched').eq('user_id', userId).order('last_touched', { ascending: false }).limit(cap),
    admin.from('daemon_archive').select('id, title, type, depth, archived_at').eq('user_id', userId).order('archived_at', { ascending: false }).limit(cap),
    admin.from('daemon_active').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    admin.from('daemon_archive').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ])
  const nodes = [
    ...(must(active, 'active') as { id: string; title: string; status: string; type: string; last_touched: string }[])
      .map(a => ({ id: a.id, kind: 'active' as const, title: a.title, detail: `${a.type} · ${a.status}`, at: a.last_touched })),
    ...(must(archive, 'archive') as { id: string; title: string; type: string; depth: number; archived_at: string }[])
      .map(a => ({ id: a.id, kind: 'archive' as const, title: a.title, detail: `${a.type} · depth ${a.depth}`, at: a.archived_at })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, cap)

  // Links are filtered in memory: an id list in the query string would overflow the URL.
  const ids = new Set(nodes.map(n => n.id))
  const edges = (must(await admin.from('daemon_links').select('id, from_id, to_id, why').eq('user_id', userId).limit(50_000), 'links') as
    { id: string; from_id: string; to_id: string; why: string }[])
    .filter(e => ids.has(e.from_id) && ids.has(e.to_id))
  return { nodes, edges, total: (activeCount.count ?? 0) + (archiveCount.count ?? 0), limit: cap }
}

// ── threads ──────────────────────────────────────────────────────────────────────

export async function getThreads(filters: { status?: string; limit?: number }) {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  let q = admin.from('daemon_threads').select('*').eq('user_id', userId)
  if (filters.status) q = q.eq('status', filters.status)
  const threads = must(await q.order('last_activity_at', { ascending: false }).limit(Math.min(filters.limit ?? 200, 500)), 'threads') as {
    id: string; topic: string; status: string; opened_by: string; expects_reply: boolean; question: string | null
    opened_at: string; last_activity_at: string; closed_at: string | null; close_reason: string | null
  }[]
  const previews = threads.length
    ? must(await admin.rpc('daemon_thread_previews', { thread_ids: threads.map(t => t.id) }), 'previews') as
      { thread_id: string; direction: string; content: string; created_at: string }[]
    : []
  return { threads, previews: Object.fromEntries(previews.map(p => [p.thread_id, p])) }
}

export async function getThreadDetail(threadId: string) {
  await requireAdmin()
  if (!UUID.test(threadId)) throw new Error('invalid thread id')
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  const thread = must(await admin.from('daemon_threads').select('*').eq('user_id', userId).eq('id', threadId).maybeSingle(), 'thread') as {
    id: string; topic: string; status: string; opened_by: string; expects_reply: boolean; question: string | null; reasoning: string | null
    referenced_active_ids: string[]; referenced_archive_ids: string[]; referenced_log_dates: string[]
    opened_at: string; last_activity_at: string; closed_at: string | null; close_reason: string | null
    working_state: string | null; open_question: string | null
  } | null
  if (!thread) return null
  const ids = [...thread.referenced_active_ids, ...thread.referenced_archive_ids]
  const [messages, dayEntries, activeRefs, archiveRefs, archivedFromActive, pendingOut, findings] = await Promise.all([
    admin.from('daemon_interaction_log').select('id, direction, call_type, content, push_sent, created_at, reasoning, working_state').eq('thread_id', threadId).order('created_at', { ascending: true }),
    admin.from('daemon_day_entries').select('entry_date, call_type, content, created_at').eq('thread_id', threadId).order('created_at', { ascending: true }),
    ids.length ? admin.from('daemon_active').select('id, title, status').in('id', ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? admin.from('daemon_archive').select('id, original_id, title, outcome').in('id', ids) : Promise.resolve({ data: [], error: null }),
    thread.referenced_active_ids.length ? admin.from('daemon_archive').select('id, original_id, title, outcome').in('original_id', thread.referenced_active_ids) : Promise.resolve({ data: [], error: null }),
    admin.from('daemon_pending_outbound').select('content, created_at, delivered_at').eq('thread_id', threadId),
    admin.from('daemon_thread_findings').select('id, query, why, results, created_at, consumed_at, consumed_by').eq('thread_id', threadId).order('created_at', { ascending: true }),
  ])
  const resolved: Record<string, string> = {}
  for (const a of must(activeRefs, 'refs') as { id: string; title: string; status: string }[]) resolved[a.id] = `${a.title} (active, ${a.status})`
  for (const a of must(archiveRefs, 'refs') as { id: string; title: string; outcome: string | null }[]) resolved[a.id] = `${a.title} (archived${a.outcome ? `: ${a.outcome}` : ''})`
  for (const a of must(archivedFromActive, 'refs') as { original_id: string; title: string; outcome: string | null }[]) {
    resolved[a.original_id] ??= `${a.title} (archived since${a.outcome ? `: ${a.outcome}` : ''})`
  }
  return {
    thread,
    messages: must(messages, 'messages') as {
      id: string; direction: string; call_type: string; content: string; push_sent: boolean; created_at: string
      reasoning: string | null; working_state: string | null
    }[],
    findings: must(findings, 'findings') as {
      id: string; query: string; why: string | null; created_at: string; consumed_at: string | null; consumed_by: string | null
      results: { kind: string; id: string; title: string; excerpt: string; created_at: string; score: number; why_matched: string }[]
    }[],
    dayEntries: must(dayEntries, 'day entries') as { entry_date: string; call_type: string; content: string; created_at: string }[],
    pendingOutbound: must(pendingOut, 'pending outbound') as { content: string; created_at: string; delivered_at: string | null }[],
    resolved,
  }
}

// ── logs ─────────────────────────────────────────────────────────────────────────

export async function getDayEntries(date: string) {
  await requireAdmin()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date')
  const userId = await getDaemonUserId()
  const [entries, dates] = await Promise.all([
    loadDayEntries(userId, date),
    createAdminClient().from('daemon_day_entries').select('entry_date').eq('user_id', userId)
      .order('entry_date', { ascending: false }).limit(2000),
  ])
  const known = [...new Set((must(dates, 'dates') as { entry_date: string }[]).map(d => d.entry_date))]
  return { entries, knownDates: known.slice(0, 120) }
}

export async function getArchiveMonth(family: Family, month: string) {
  await requireAdmin()
  if (!FAMILIES.includes(family)) throw new Error('invalid family')
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('invalid month')
  const userId = await getDaemonUserId()
  const [locations, files] = await Promise.all([readMonth(userId, family, month), listFamilyFiles(userId, family)])
  return { locations, files }
}

// ── metrics ──────────────────────────────────────────────────────────────────────

export async function getMetricsDashboard(windowDays: number, seriesDays: number) {
  await requireAdmin()
  const userId = await getDaemonUserId()
  const admin = createAdminClient()
  const since = startOfLocalDay(new Date(Date.now() - (seriesDays - 1) * 86_400_000)).toISOString()
  const [metrics, usage, pings, inbound] = await Promise.all([
    computeMetrics(userId, windowDays),
    admin.from('daemon_usage').select('call_type, model, cost_usd, error, created_at, system_prompt_version, call_prompt_version, dry_run')
      .gte('created_at', since).order('created_at', { ascending: true }).limit(20_000),
    admin.from('daemon_interaction_log').select('thread_id, created_at').eq('user_id', userId)
      .eq('direction', 'out').eq('call_type', 'heartbeat').gte('created_at', since).limit(20_000),
    admin.from('daemon_interaction_log').select('thread_id, created_at').eq('user_id', userId)
      .eq('direction', 'in').neq('call_type', 'system').gte('created_at', since).limit(20_000),
  ])
  const usageRows = must(usage, 'usage') as {
    call_type: string; model: string; cost_usd: number | string; error: string | null; created_at: string
    system_prompt_version: number | null; call_prompt_version: number | null; dry_run: boolean
  }[]

  const days: string[] = []
  for (let i = seriesDays - 1; i >= 0; i--) days.push(localDate(new Date(Date.now() - i * 86_400_000)))
  const series = Object.fromEntries(days.map(d => [d, { cost: 0, calls: 0, errors: 0, pings: 0, replied: 0 }]))

  for (const u of usageRows) {
    if (u.model === 'n/a') continue
    const s = series[localDate(new Date(u.created_at))]
    if (!s) continue
    s.cost += Number(u.cost_usd ?? 0)
    s.calls++
    if (u.error) s.errors++
  }
  const inboundByThread = new Map<string, number[]>()
  for (const m of must(inbound, 'inbound') as { thread_id: string | null; created_at: string }[]) {
    if (m.thread_id) inboundByThread.set(m.thread_id, [...(inboundByThread.get(m.thread_id) ?? []), Date.parse(m.created_at)])
  }
  for (const p of must(pings, 'pings') as { thread_id: string | null; created_at: string }[]) {
    const s = series[localDate(new Date(p.created_at))]
    if (!s) continue
    s.pings++
    const t = Date.parse(p.created_at)
    if (p.thread_id && (inboundByThread.get(p.thread_id) ?? []).some(x => x > t)) s.replied++
  }

  // Prompt-version change markers: the first real call that ran on a version different
  // from the previous call of the same kind (dry runs excluded).
  const markers: { date: string; at: string; label: string }[] = []
  const last: Record<string, number | null> = {}
  const mark = (key: string, version: number | null, at: string, label: string) => {
    if (version === null) return
    if (key in last && last[key] !== version) markers.push({ date: localDate(new Date(at)), at, label })
    last[key] = version
  }
  for (const u of usageRows) {
    if (u.model === 'n/a' || u.dry_run) continue
    mark('system', u.system_prompt_version, u.created_at, `system v${u.system_prompt_version}`)
    mark(u.call_type, u.call_prompt_version, u.created_at, `${u.call_type} v${u.call_prompt_version}`)
  }

  return {
    metrics,
    series: days.map(d => ({ date: d, ...series[d], cost: Math.round(series[d].cost * 10_000) / 10_000 })),
    markers,
    capUsd: daemonEnv.dailyCostCapUsd(),
  }
}

// ── usage ledger ─────────────────────────────────────────────────────────────────

export async function getUsage(filters: { callType?: string; from?: string; to?: string; errorsOnly?: boolean }) {
  await requireAdmin()
  const admin = createAdminClient()
  const fromIso = filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)
    ? startOfLocalDay(new Date(`${filters.from}T12:00:00Z`)).toISOString()
    : startOfLocalDay(new Date(Date.now() - 6 * 86_400_000)).toISOString()
  const toIso = filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)
    ? new Date(startOfLocalDay(new Date(`${filters.to}T12:00:00Z`)).getTime() + 86_400_000).toISOString()
    : new Date(Date.now() + 60_000).toISOString()
  let q = admin.from('daemon_usage').select('*').gte('created_at', fromIso).lt('created_at', toIso)
  if (filters.callType) q = q.eq('call_type', filters.callType)
  if (filters.errorsOnly) q = q.not('error', 'is', null)
  const rows = must(await q.order('created_at', { ascending: false }).limit(1000), 'usage') as {
    id: string; call_type: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number | string
    error: string | null; attempt: number; note: string | null; created_at: string
    system_prompt_version: number | null; call_prompt_version: number | null; dry_run: boolean
  }[]
  const daily: Record<string, { cost: number; calls: number; errors: number; unknownCost: number }> = {}
  for (const r of rows) {
    const d = localDate(new Date(r.created_at))
    const t = (daily[d] ??= { cost: 0, calls: 0, errors: 0, unknownCost: 0 })
    if (r.cost_usd === null) t.unknownCost++
    else t.cost += Number(r.cost_usd)
    if (r.model !== 'n/a') t.calls++
    if (r.error) t.errors++
  }
  return { rows, daily, capUsd: daemonEnv.dailyCostCapUsd(), truncated: rows.length === 1000 }
}

// ── model routing & prices ──────────────────────────────────────────────────────

const MODEL_KINDS: ModelKind[] = ['input', 'heartbeat', 'reflection', 'meta', 'embedding']

export async function getModelRouting() {
  await requireAdmin()
  const admin = createAdminClient()
  const rows = must(await admin.from('daemon_model_config').select('call_type, model, max_output_tokens, note, updated_at'), 'model config') as
    { call_type: ModelKind; model: string; max_output_tokens: number | null; note: string | null; updated_at: string }[]
  const byKind = new Map(rows.map(r => [r.call_type, r]))
  const resolved = await Promise.all(MODEL_KINDS.map(async kind => ({ kind, ...(await peekModelFor(kind)) })))
  return MODEL_KINDS.map(kind => {
    const row = byKind.get(kind) ?? null
    const res = resolved.find(r => r.kind === kind)!
    return {
      call_type: kind,
      db_model: row?.model ?? null,
      max_output_tokens: row?.max_output_tokens ?? null,
      note: row?.note ?? null,
      updated_at: row?.updated_at ?? null,
      resolved_model: res.model || null,
      source: res.source as 'db' | 'env' | 'none',
    }
  })
}

// One row per call type; there is no daemon_output_path from a model response to this
// table — see the file header for the isolation this preserves.
export async function saveModelConfig(callType: ModelKind, model: string, maxOutputTokens: number | null, note: string): Promise<void> {
  const email = await requireAdmin()
  if (!MODEL_KINDS.includes(callType)) throw new Error('invalid call type')
  if (!model.trim()) throw new Error('model must not be empty')
  if (maxOutputTokens !== null && (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0)) throw new Error('max_output_tokens must be a positive number or empty')
  const userId = await getDaemonUserId()
  const { error } = await createAdminClient().from('daemon_model_config').upsert({
    call_type: callType, model: model.trim(), max_output_tokens: maxOutputTokens, note: note.trim() || null, updated_at: new Date().toISOString(),
  }, { onConflict: 'call_type' })
  if (error) throw new Error(error.message)
  invalidateModelCache()
  await logOperatorAction(userId, `set ${callType} model to '${model.trim()}' by ${email}${note.trim() ? `: ${note.trim()}` : ''}`)
  revalidatePath('/daemon/models')
}

export async function getModelPrices() {
  await requireAdmin()
  const admin = createAdminClient()
  const [prices, usageModels] = await Promise.all([
    admin.from('daemon_model_prices').select('*').order('model', { ascending: true }),
    admin.from('daemon_usage').select('model').neq('model', 'n/a').limit(20_000),
  ])
  const rows = must(prices, 'prices') as {
    model: string; input_per_mtok: number; output_per_mtok: number; cached_input_per_mtok: number | null
    effective_from: string | null; note: string | null; updated_at: string
  }[]
  const priced = new Set(rows.map(r => r.model))
  const unpriced = [...new Set((must(usageModels, 'usage models') as { model: string }[]).map(m => m.model))].filter(m => !priced.has(m)).sort()
  return { prices: rows, unpricedModelsInUse: unpriced }
}

// This is the one place a typed number affects a safety bound: isOverBudget() prices
// every call from this table. The console must warn on save before calling this.
export async function saveModelPrice(input: {
  model: string; inputPerMtok: number; outputPerMtok: number; cachedInputPerMtok: number | null; effectiveFrom: string | null; note: string
}): Promise<void> {
  const email = await requireAdmin()
  const model = input.model.trim()
  if (!model) throw new Error('model must not be empty')
  if (!Number.isFinite(input.inputPerMtok) || input.inputPerMtok < 0) throw new Error('input price must be a non-negative number')
  if (!Number.isFinite(input.outputPerMtok) || input.outputPerMtok < 0) throw new Error('output price must be a non-negative number')
  if (input.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new Error('effective_from must be YYYY-MM-DD')
  const userId = await getDaemonUserId()
  const { error } = await createAdminClient().from('daemon_model_prices').upsert({
    model, input_per_mtok: input.inputPerMtok, output_per_mtok: input.outputPerMtok,
    cached_input_per_mtok: input.cachedInputPerMtok, effective_from: input.effectiveFrom, note: input.note.trim() || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'model' })
  if (error) throw new Error(error.message)
  invalidatePriceCache()
  await logOperatorAction(userId, `set price for '${model}' to ${input.inputPerMtok}/${input.outputPerMtok} per Mtok by ${email} (affects the cost cap)${input.note.trim() ? `: ${input.note.trim()}` : ''}`)
  revalidatePath('/daemon/models')
}

export async function getModelUsageSummary(days: number) {
  await requireAdmin()
  const since = startOfLocalDay(new Date(Date.now() - (Math.min(Math.max(days, 1), 90) - 1) * 86_400_000)).toISOString()
  const rows = must(await createAdminClient().from('daemon_usage')
    .select('model, call_type, input_tokens, output_tokens, cost_usd, dry_run')
    .gte('created_at', since).neq('model', 'n/a').limit(20_000), 'usage') as
    { model: string; call_type: string; input_tokens: number; output_tokens: number; cost_usd: number | string | null; dry_run: boolean }[]
  const key = (r: { model: string; call_type: string }) => `${r.model}::${r.call_type}`
  const groups = new Map<string, { model: string; call_type: string; calls: number; dry_runs: number; input_tokens: number; output_tokens: number; cost_usd: number; unknown_cost_calls: number }>()
  for (const r of rows) {
    const g = groups.get(key(r)) ?? { model: r.model, call_type: r.call_type, calls: 0, dry_runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unknown_cost_calls: 0 }
    g.calls++
    if (r.dry_run) g.dry_runs++
    g.input_tokens += r.input_tokens
    g.output_tokens += r.output_tokens
    if (r.cost_usd === null) g.unknown_cost_calls++
    else g.cost_usd += Number(r.cost_usd)
    groups.set(key(r), g)
  }
  return [...groups.values()].sort((a, b) => b.cost_usd - a.cost_usd || a.model.localeCompare(b.model))
}
