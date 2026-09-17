import { createAdminClient } from '@/lib/supabase/admin'
import { generate } from './gemini'
import {
  HEARTBEAT_SCHEMA, INPUT_SCHEMA, REFLECTION_SCHEMA,
  validateHeartbeat, validateInput, validateReflection,
  type ItemFields,
} from './schemas'
import { buildHeartbeatTurns, buildInputTurns, buildReflectionTurns, loadActive, system, type ActiveItem, type ArchiveItem } from './context'
import { appendDayBlock, rotate, writeDayBlock } from './files'
import { notify } from './notify'
import { acquireLock, releaseLock, updateState } from './state'
import { annotateUsage } from './usage'
import { reflectionDay } from './time'

const MIN_WAKE_GAP_MS = 10 * 60 * 1000
const PROVISIONAL_WAKE_MS = 30 * 60 * 1000
const MAX_PENDING_PER_CALL = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A wake time in the past (or seconds away) would fire on every tick; the budget cap
// is the hard backstop, this is the soft one.
function clampWake(iso: string): string {
  const floor = Date.now() + MIN_WAKE_GAP_MS
  return new Date(Math.max(Date.parse(iso), floor)).toISOString()
}

const normTags = (tags: string[]) => [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))]

function fieldsToRow(fields: ItemFields, current: ActiveItem): Record<string, unknown> {
  const row: Record<string, unknown> = { last_touched: new Date().toISOString() }
  if (fields.title !== undefined) row.title = fields.title
  if (fields.content !== undefined) row.content = fields.content
  if (fields.status !== undefined) row.status = fields.status
  if (fields.type !== undefined) row.type = fields.type
  if (fields.tags !== undefined) row.tags = normTags(fields.tags)
  if (fields.deadline !== undefined) {
    row.deadline = fields.deadline
    if (current.deadline && fields.deadline && Date.parse(fields.deadline) > Date.parse(current.deadline)) {
      row.reschedule_count = current.reschedule_count + 1
    }
  }
  return row
}

async function updateActive(activeById: Map<string, ActiveItem>, id: string, fields: ItemFields): Promise<void> {
  const current = activeById.get(id)
  if (!current) return console.warn('[daemon] update skipped, unknown active id', id)
  const { error } = await createAdminClient().from('daemon_active').update(fieldsToRow(fields, current)).eq('id', id)
  if (error) console.error('[daemon] update failed', id, error.message)
}

async function archiveActive(userId: string, activeById: Map<string, ActiveItem>, id: string, outcome: string, why: string): Promise<string | null> {
  const current = activeById.get(id)
  if (!current) {
    console.warn('[daemon] archive skipped, unknown active id', id)
    return null
  }
  const admin = createAdminClient()
  const { data, error } = await admin.from('daemon_archive').insert({
    user_id: userId,
    original_id: current.id,
    type: current.type,
    title: current.title,
    content: current.content,
    tags: current.tags,
    outcome,
    why_archived: why,
    created_at: current.created_at,
  }).select('id').single()
  if (error) {
    console.error('[daemon] archive insert failed', id, error.message)
    return null
  }
  const { error: delErr } = await admin.from('daemon_active').delete().eq('id', id)
  if (delErr) console.error('[daemon] archive delete failed (row now in both tables)', id, delErr.message)
  activeById.delete(id)
  return data.id as string
}

// ── input ──────────────────────────────────────────────────────────────────────

// Answers every unprocessed pending message in one call. Caller must hold the lock.
// Returns null if the queue was empty.
export async function runInput(userId: string, opts: { push: boolean }): Promise<{ reply: string; processedIds: string[] } | null> {
  const admin = createAdminClient()
  const { data: pending, error } = await admin
    .from('daemon_pending_input')
    .select('id, content')
    .eq('user_id', userId)
    .is('processed_at', null)
    .order('received_at', { ascending: true })
    .limit(MAX_PENDING_PER_CALL)
  if (error) throw new Error(`pending input read failed: ${error.message}`)
  if (!pending?.length) return null

  const turns = await buildInputTurns(userId, pending.map(p => p.content))
  const { data } = await generate({
    callType: 'input', userId, system: system(), turns, schema: INPUT_SCHEMA, validate: validateInput,
  })

  const activeById = new Map((await loadActive(userId)).map(a => [a.id, a]))
  for (const action of data.actions) {
    try {
      switch (action.op) {
        case 'create': {
          const { error: insErr } = await admin.from('daemon_active').insert({
            user_id: userId, type: action.type, title: action.title, content: action.content,
            tags: normTags(action.tags), deadline: action.deadline,
          })
          if (insErr) console.error('[daemon] create failed', insErr.message)
          break
        }
        case 'update':
          await updateActive(activeById, action.id, action.fields)
          break
        case 'archive':
          await archiveActive(userId, activeById, action.id, action.outcome, action.why)
          break
        case 'calendar_write':
          await writeDayBlock(userId, 'calendar', action.date, action.block)
          break
      }
    } catch (e) {
      console.error('[daemon] action failed', action.op, (e as Error).message)
    }
  }

  const processedIds = pending.map(p => p.id)
  await admin.from('daemon_pending_input').update({ processed_at: new Date().toISOString() }).in('id', processedIds)
  if (data.next_wake_time) await updateState({ next_wake_time: clampWake(data.next_wake_time) })
  await notify(userId, data.reply, 'input', opts.push)
  return { reply: data.reply, processedIds }
}

export async function hasPendingInput(userId: string): Promise<boolean> {
  const { count } = await createAdminClient()
    .from('daemon_pending_input')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('processed_at', null)
  return (count ?? 0) > 0
}

// Takes the lock and answers queued messages, pushing the reply (the user already got
// a 202). Returns whether anything was processed.
export async function drainPendingInput(userId: string): Promise<boolean> {
  if (!(await hasPendingInput(userId))) return false
  const lock = await acquireLock('input')
  if (!lock) return false
  try {
    return (await runInput(userId, { push: true })) !== null
  } finally {
    await releaseLock(lock)
  }
}

// ── heartbeat ──────────────────────────────────────────────────────────────────

// Caller must hold the lock. Read-only on item content: only last_nudged_at is written.
export async function runHeartbeat(userId: string): Promise<{ pinged: boolean; nextWake: string; reasoning: string }> {
  const now = new Date()
  // Provisional values first, so a crash or bad output can't cause indefinite silence
  // or a retry on every tick.
  await updateState({
    next_wake_time: new Date(now.getTime() + PROVISIONAL_WAKE_MS).toISOString(),
    last_heartbeat_at: now.toISOString(),
  })

  const turns = await buildHeartbeatTurns(userId)
  const { data, usageId } = await generate({
    callType: 'heartbeat', userId, system: system(), turns, schema: HEARTBEAT_SCHEMA, validate: validateHeartbeat,
  })
  await annotateUsage(usageId, `reasoning: ${data.reasoning}`)

  const nextWake = clampWake(data.next_wake_time)
  await updateState({ next_wake_time: nextWake })

  const pinged = data.should_ping && !!data.message
  if (pinged) {
    const ids = data.target_ids.filter(id => UUID.test(id))
    if (ids.length) {
      await createAdminClient()
        .from('daemon_active')
        .update({ last_nudged_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('id', ids)
    }
    await notify(userId, data.message!, 'heartbeat')
  }
  return { pinged, nextWake, reasoning: data.reasoning }
}

// ── reflection ─────────────────────────────────────────────────────────────────

// Caller must hold the lock.
export async function runReflection(userId: string): Promise<Record<string, unknown>> {
  const day = reflectionDay()
  const [calRot, refRot] = await Promise.all([
    rotate(userId, 'calendar', day),
    rotate(userId, 'reflection', day),
  ])

  const turns = await buildReflectionTurns(userId)
  const { data } = await generate({
    callType: 'reflection', userId, system: system(), turns, schema: REFLECTION_SCHEMA, validate: validateReflection,
  })

  const admin = createAdminClient()
  const activeById = new Map((await loadActive(userId)).map(a => [a.id, a]))

  const promoted: string[] = []
  for (const p of data.promote) {
    if (!UUID.test(p.archive_id)) continue
    const { data: row } = await admin.from('daemon_archive').select('*').eq('id', p.archive_id).eq('user_id', userId).maybeSingle()
    if (!row) {
      console.warn('[daemon] promote skipped, unknown archive id', p.archive_id)
      continue
    }
    const a = row as ArchiveItem
    const base = {
      user_id: userId,
      type: ['task', 'problem', 'note'].includes(a.type) ? a.type : 'note',
      title: a.title, content: a.content, tags: a.tags, created_at: a.created_at,
    }
    let { error } = await admin.from('daemon_active').insert({ ...base, ...(a.original_id ? { id: a.original_id } : {}) })
    if (error && a.original_id) ({ error } = await admin.from('daemon_active').insert(base))
    if (error) {
      console.error('[daemon] promote insert failed', a.id, error.message)
      continue
    }
    await admin.from('daemon_archive').delete().eq('id', a.id)
    promoted.push(a.id)
    console.log('[daemon] promoted', a.id, p.why_now)
  }

  const { error: bumpErr } = await admin.rpc('daemon_bump_archive_depth', { exclude_ids: promoted })
  if (bumpErr) console.error('[daemon] archive depth bump failed', bumpErr.message)

  for (const u of data.updates) await updateActive(activeById, u.active_id, u.fields)
  for (const d of data.demote) await archiveActive(userId, activeById, d.active_id, d.outcome, d.why)

  await appendDayBlock(userId, 'reflection', day, data.todays_log)
  await writeDayBlock(userId, 'calendar', data.calendar_roll.date, data.calendar_roll.block)
  if (data.tomorrow_plan.block) await writeDayBlock(userId, 'calendar', data.tomorrow_plan.date, data.tomorrow_plan.block)

  await updateState({
    next_wake_time: clampWake(data.next_wake_time),
    last_reflection_at: new Date().toISOString(),
    last_reflection_day: day,
  })

  return {
    day,
    rotation: { calendar: calRot, reflection: refRot },
    promoted: promoted.length,
    demoted: data.demote.length,
    updated: data.updates.length,
  }
}
