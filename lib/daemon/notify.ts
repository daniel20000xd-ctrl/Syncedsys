import { createAdminClient } from '@/lib/supabase/admin'
import { pushToAll } from './apns'
import { getState } from './state'
import { isWakingHours } from './time'

export type OutboundCallType = 'input' | 'heartbeat' | 'reflection' | 'meta' | 'system'

const TITLE = 'Daemon'
const BODY_MAX = 180

export function truncateForPush(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length <= BODY_MAX ? flat : `${flat.slice(0, BODY_MAX - 1).trimEnd()}…`
}

// Logs the outbound message, then pushes it unless shadow mode is on (or `push` is
// false, e.g. a reply already returned synchronously to the app).
// `deferOutsideWakingHours`: during quiet hours, queue it in daemon_pending_outbound
// instead; the first waking scheduler tick logs and delivers it.
export async function notify(
  userId: string,
  message: string,
  callType: OutboundCallType,
  { push = true, threadId = null, deferOutsideWakingHours = false, reasoning = null, workingState = null }: {
    push?: boolean; threadId?: string | null; deferOutsideWakingHours?: boolean
    // Stored on the message row for the console and later turns; never pushed.
    reasoning?: string | null; workingState?: string | null
  } = {},
): Promise<{ pushed: boolean; deferred: boolean }> {
  const admin = createAdminClient()
  if (deferOutsideWakingHours && !isWakingHours()) {
    const { error } = await admin.from('daemon_pending_outbound')
      .insert({ user_id: userId, thread_id: threadId, call_type: callType, content: message })
    if (error) throw new Error(`pending outbound insert failed: ${error.message}`)
    return { pushed: false, deferred: true }
  }
  const { data: row, error } = await admin
    .from('daemon_interaction_log')
    .insert({
      user_id: userId, direction: 'out', call_type: callType, content: message, push_sent: false, thread_id: threadId,
      ...(reasoning ? { reasoning } : {}), ...(workingState ? { working_state: workingState } : {}),
    })
    .select('id')
    .single()
  if (error) throw new Error(`interaction log insert failed: ${error.message}`)

  if (!push) return { pushed: false, deferred: false }
  const { shadow_mode } = await getState()
  if (shadow_mode) return { pushed: false, deferred: false }

  let delivered = 0
  try {
    delivered = await pushToAll(userId, {
      aps: { alert: { title: TITLE, body: truncateForPush(message) }, sound: 'default' },
      kind: 'daemon_message',
      thread_id: threadId,
    })
  } catch (e) {
    console.error('[daemon/notify] push failed:', (e as Error).message)
  }
  if (delivered > 0) await admin.from('daemon_interaction_log').update({ push_sent: true }).eq('id', row.id)
  return { pushed: delivered > 0, deferred: false }
}

// Delivers messages held back during quiet hours, oldest first. Each row is claimed
// atomically so overlapping ticks can't deliver it twice; a failed delivery is unclaimed.
export async function drainPendingOutbound(userId: string): Promise<number> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('daemon_pending_outbound')
    .select('id, thread_id, call_type, content')
    .eq('user_id', userId).is('delivered_at', null)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`pending outbound read failed: ${error.message}`)

  let delivered = 0
  for (const row of data ?? []) {
    const { data: claimed } = await admin.from('daemon_pending_outbound')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', row.id).is('delivered_at', null)
      .select('id')
    if (!claimed?.length) continue
    try {
      await notify(userId, row.content, row.call_type as OutboundCallType, { threadId: row.thread_id })
      if (row.thread_id) {
        await admin.from('daemon_threads').update({ last_activity_at: new Date().toISOString() }).eq('id', row.thread_id)
      }
      delivered++
    } catch (e) {
      await admin.from('daemon_pending_outbound').update({ delivered_at: null }).eq('id', row.id)
      throw e
    }
  }
  return delivered
}
