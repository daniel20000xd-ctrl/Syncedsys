import { createAdminClient, listAllAuthUsers } from '@/lib/supabase/admin'
import { daemonEnv } from './env'

export type Holder = 'input' | 'heartbeat' | 'reflection'

export type DaemonState = {
  id: number
  user_id: string | null
  is_processing: boolean
  holder: Holder | null
  lock_acquired_at: string | null
  next_wake_time: string | null
  last_heartbeat_at: string | null
  last_reflection_at: string | null
  last_reflection_day: string | null
  budget_alert_day: string | null
  last_failure_alert_at: string | null
  enabled: boolean
  shadow_mode: boolean
  updated_at: string
}

// Identifies the acquisition so a holder whose lock was force-released as stale
// can't later release someone else's lock.
export type Lock = { holder: Holder; acquiredAt: string }

export async function getState(): Promise<DaemonState> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('daemon_state').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`daemon_state read failed: ${error.message}`)
  if (data) return data as DaemonState
  const { data: created, error: insErr } = await admin
    .from('daemon_state').upsert({ id: 1 }, { onConflict: 'id', ignoreDuplicates: true }).select('*').maybeSingle()
  if (insErr) throw new Error(`daemon_state init failed: ${insErr.message}`)
  if (created) return created as DaemonState
  return getState()
}

export async function updateState(fields: Partial<Omit<DaemonState, 'id'>>): Promise<void> {
  const { error } = await createAdminClient()
    .from('daemon_state')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', 1)
  if (error) throw new Error(`daemon_state update failed: ${error.message}`)
}

// Single user: the ADMIN_EMAIL account. Resolved once and cached on the state row.
export async function getDaemonUserId(): Promise<string> {
  const state = await getState()
  if (state.user_id) return state.user_id
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  if (!adminEmail) throw new Error('ADMIN_EMAIL not configured')
  const users = await listAllAuthUsers(createAdminClient())
  const user = users.find(u => u.email?.trim().toLowerCase() === adminEmail)
  if (!user) throw new Error('Admin user not found')
  await updateState({ user_id: user.id })
  return user.id
}

// Atomic: a single conditional UPDATE, so two concurrent callers can't both win.
// A lock older than DAEMON_LOCK_TIMEOUT_SECONDS is treated as crashed and taken over.
export async function acquireLock(holder: Holder): Promise<Lock | null> {
  await getState()
  const now = new Date()
  const staleBefore = new Date(now.getTime() - daemonEnv.lockTimeoutSeconds() * 1000).toISOString()
  const acquiredAt = now.toISOString()
  const { data, error } = await createAdminClient()
    .from('daemon_state')
    .update({ is_processing: true, holder, lock_acquired_at: acquiredAt, updated_at: acquiredAt })
    .eq('id', 1)
    .or(`is_processing.eq.false,lock_acquired_at.is.null,lock_acquired_at.lt."${staleBefore}"`)
    .select('id')
  if (error) throw new Error(`lock acquire failed: ${error.message}`)
  return data && data.length > 0 ? { holder, acquiredAt } : null
}

export async function acquireLockWithRetry(holder: Holder, maxWaitMs: number, intervalMs = 3000): Promise<Lock | null> {
  const deadline = Date.now() + maxWaitMs
  for (;;) {
    const lock = await acquireLock(holder)
    if (lock || Date.now() + intervalMs > deadline) return lock
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

export async function releaseLock(lock: Lock): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await createAdminClient()
    .from('daemon_state')
    .update({ is_processing: false, holder: null, lock_acquired_at: null, updated_at: now })
    .eq('id', 1)
    .eq('lock_acquired_at', lock.acquiredAt)
  if (error) console.error('[daemon] lock release failed:', error.message)
}
