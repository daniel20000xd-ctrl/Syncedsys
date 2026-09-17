import { createAdminClient } from '@/lib/supabase/admin'
import { drainPendingInput, runHeartbeat, runMeta, runReflection } from './calls'
import { OverBudgetError } from './gemini'
import { sendBudgetAlert, sendFailureAlert } from './alert'
import { acquireLock, acquireLockWithRetry, getDaemonUserId, getState, releaseLock } from './state'
import { isOverBudget } from './usage'
import { daemonEnv } from './env'
import { closeStaleThreads } from './threads'
import { drainPendingOutbound } from './notify'
import { embedPending } from './embeddings'
import { isWakingHours, localDate, reflectionDay } from './time'

export type JobResult = { status: number; body: Record<string, unknown> }

const ok = (body: Record<string, unknown>): JobResult => ({ status: 200, body })
const META_MIN_INTERVAL_MS = 6 * 86_400_000

// Feeds the heartbeat metrics (ran vs. skipped because locked, etc.).
async function recordTick(outcome: string): Promise<void> {
  const { error } = await createAdminClient().from('daemon_tick_log').insert({ outcome })
  if (error) console.error('[daemon] tick log insert failed:', error.message)
}

async function budgetStop(): Promise<JobResult | null> {
  if (!(await isOverBudget())) return null
  const cap = daemonEnv.dailyCostCapUsd()
  await sendBudgetAlert(localDate(), cap === null
    ? 'DAEMON_DAILY_COST_CAP_USD is not set (or the usage ledger is unreadable); all model calls are blocked.'
    : `Today's model spend reached the $${cap} cap. Model calls are paused until tomorrow.`)
  return ok({ skipped: 'over_budget' })
}

async function failed(what: string, e: unknown): Promise<JobResult> {
  const message = (e as Error).message
  if (e instanceof OverBudgetError) return ok({ skipped: 'over_budget' })
  await sendFailureAlert(`${what} failed`, message)
  return { status: 500, body: { error: message } }
}

// The cheap 5-minute tick. `force` (debug only) skips the quiet-hours and due checks.
// Afterwards it sweeps any rows still missing embeddings (no-op unless vector search is on).
export async function schedulerTick({ force = false } = {}): Promise<JobResult> {
  const result = await tick(force)
  if (result.body.skipped !== 'disabled' && result.body.skipped !== 'over_budget') {
    const embedded = await embedPending()
    if (embedded) result.body.embedded = embedded
  }
  return result
}

async function tick(force: boolean): Promise<JobResult> {
  try {
    const state = await getState()
    if (!state.enabled) return ok({ skipped: 'disabled' })
    if (!force && !isWakingHours()) return ok({ skipped: 'quiet_hours' })
    const userId = await getDaemonUserId()

    // Messages held back during quiet hours go out before anything else.
    const outbound = await drainPendingOutbound(userId)
    if (outbound) await recordTick('outbound_drain')

    await closeStaleThreads(userId)
    const stop = await budgetStop()
    if (stop) {
      await recordTick('over_budget')
      return stop
    }

    // Queued user messages go ahead of heartbeats.
    if (await drainPendingInput(userId)) {
      await recordTick('input_drain')
      return ok({ ran: 'input_drain', outbound_delivered: outbound })
    }

    const now = Date.now()
    const wakeDue = !state.next_wake_time || now >= Date.parse(state.next_wake_time)
    const gapDue = !state.last_heartbeat_at || now - Date.parse(state.last_heartbeat_at) > daemonEnv.maxGapMinutes() * 60_000
    if (!force && !wakeDue && !gapDue) {
      return ok({ skipped: 'not_due', next_wake_time: state.next_wake_time, outbound_delivered: outbound })
    }

    const lock = await acquireLock('heartbeat')
    if (!lock) {
      await recordTick('locked')
      return ok({ skipped: 'locked', outbound_delivered: outbound })
    }
    try {
      const result = await runHeartbeat(userId)
      await recordTick('heartbeat')
      return ok({ ran: 'heartbeat', due: force ? 'forced' : wakeDue ? 'wake_time' : 'max_gap', outbound_delivered: outbound, ...result })
    } finally {
      await releaseLock(lock)
    }
  } catch (e) {
    await recordTick('error')
    return failed('heartbeat', e)
  }
}

// Nightly. Idempotent per reflection day unless forced. Waits briefly for the lock; if
// it's still held, returns 409 so the external trigger retries (maxDuration is 60s).
export async function reflectionJob({ force = false } = {}): Promise<JobResult> {
  try {
    const state = await getState()
    if (!state.enabled) return ok({ skipped: 'disabled' })
    const day = reflectionDay()
    if (!force && state.last_reflection_day === day) return ok({ skipped: 'already_reflected', day })
    const stop = await budgetStop()
    if (stop) return stop

    const userId = await getDaemonUserId()
    const lock = await acquireLockWithRetry('reflection', 20_000)
    if (!lock) return { status: 409, body: { error: 'locked', retry: true } }
    let body: Record<string, unknown>
    try {
      body = await runReflection(userId)
    } finally {
      await releaseLock(lock)
    }
    // Outside the lock: embedding the night's new rows shouldn't hold up anything else.
    return ok({ ran: 'reflection', ...body, embedded: await embedPending(100) })
  } catch (e) {
    return failed('reflection', e)
  }
}

// Weekly. Same lock/retry and budget rules as reflection; skipped if a meta run
// completed within the last six days, unless forced.
export async function metaJob({ force = false } = {}): Promise<JobResult> {
  try {
    const state = await getState()
    if (!state.enabled) return ok({ skipped: 'disabled' })
    if (!force && state.last_meta_at && Date.now() - Date.parse(state.last_meta_at) < META_MIN_INTERVAL_MS) {
      return ok({ skipped: 'already_ran_this_week', last_meta_at: state.last_meta_at })
    }
    const stop = await budgetStop()
    if (stop) return stop

    const userId = await getDaemonUserId()
    const lock = await acquireLockWithRetry('meta', 20_000)
    if (!lock) return { status: 409, body: { error: 'locked', retry: true } }
    let body: Record<string, unknown>
    try {
      body = await runMeta(userId)
    } finally {
      await releaseLock(lock)
    }
    // Outside the lock: embedding the night's new rows shouldn't hold up anything else.
    return ok({ ran: 'meta', ...body, embedded: await embedPending(100) })
  } catch (e) {
    return failed('meta', e)
  }
}
