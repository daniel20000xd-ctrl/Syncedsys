import { drainPendingInput, runHeartbeat, runReflection } from './calls'
import { OverBudgetError } from './gemini'
import { sendBudgetAlert, sendFailureAlert } from './alert'
import { acquireLock, acquireLockWithRetry, getDaemonUserId, getState, releaseLock } from './state'
import { isOverBudget } from './usage'
import { daemonEnv } from './env'
import { closeStaleThreads } from './threads'
import { isWakingHours, localDate, reflectionDay } from './time'

export type JobResult = { status: number; body: Record<string, unknown> }

const ok = (body: Record<string, unknown>): JobResult => ({ status: 200, body })

async function budgetStop(): Promise<JobResult | null> {
  if (!(await isOverBudget())) return null
  const cap = daemonEnv.dailyCostCapUsd()
  await sendBudgetAlert(localDate(), cap === null
    ? 'DAEMON_DAILY_COST_CAP_USD is not set (or the usage ledger is unreadable); all model calls are blocked.'
    : `Today's model spend reached the $${cap} cap. Heartbeats and reflection are paused until tomorrow.`)
  return ok({ skipped: 'over_budget' })
}

async function failed(what: string, e: unknown): Promise<JobResult> {
  const message = (e as Error).message
  if (e instanceof OverBudgetError) return ok({ skipped: 'over_budget' })
  await sendFailureAlert(`${what} failed`, message)
  return { status: 500, body: { error: message } }
}

// The cheap 5-minute tick. `force` (debug only) skips the quiet-hours and due checks.
export async function schedulerTick({ force = false } = {}): Promise<JobResult> {
  try {
    const state = await getState()
    if (!state.enabled) return ok({ skipped: 'disabled' })
    if (!force && !isWakingHours()) return ok({ skipped: 'quiet_hours' })
    const userId = await getDaemonUserId()
    await closeStaleThreads(userId)
    const stop = await budgetStop()
    if (stop) return stop

    // Queued user messages go ahead of anything else.
    if (await drainPendingInput(userId)) return ok({ ran: 'input_drain' })

    const now = Date.now()
    const wakeDue = !state.next_wake_time || now >= Date.parse(state.next_wake_time)
    const gapDue = !state.last_heartbeat_at || now - Date.parse(state.last_heartbeat_at) > daemonEnv.maxGapMinutes() * 60_000
    if (!force && !wakeDue && !gapDue) return ok({ skipped: 'not_due', next_wake_time: state.next_wake_time })

    const lock = await acquireLock('heartbeat')
    if (!lock) return ok({ skipped: 'locked' })
    try {
      const result = await runHeartbeat(userId)
      return ok({ ran: 'heartbeat', due: force ? 'forced' : wakeDue ? 'wake_time' : 'max_gap', ...result })
    } finally {
      await releaseLock(lock)
    }
  } catch (e) {
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
    try {
      return ok({ ran: 'reflection', ...(await runReflection(userId)) })
    } finally {
      await releaseLock(lock)
    }
  } catch (e) {
    return failed('reflection', e)
  }
}
