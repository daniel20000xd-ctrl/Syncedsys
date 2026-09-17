import { createAdminClient } from '@/lib/supabase/admin'
import { pushToAll } from './apns'
import { getState } from './state'

export type OutboundCallType = 'input' | 'heartbeat' | 'reflection' | 'system'

const TITLE = 'Daemon'
const BODY_MAX = 180

export function truncateForPush(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length <= BODY_MAX ? flat : `${flat.slice(0, BODY_MAX - 1).trimEnd()}…`
}

// Logs the outbound message, then pushes it unless shadow mode is on (or `push` is
// false, e.g. a reply already returned synchronously to the app).
export async function notify(
  userId: string,
  message: string,
  callType: OutboundCallType,
  { push = true, threadId = null }: { push?: boolean; threadId?: string | null } = {},
): Promise<{ pushed: boolean }> {
  const admin = createAdminClient()
  const { data: row, error } = await admin
    .from('daemon_interaction_log')
    .insert({ user_id: userId, direction: 'out', call_type: callType, content: message, push_sent: false, thread_id: threadId })
    .select('id')
    .single()
  if (error) throw new Error(`interaction log insert failed: ${error.message}`)

  if (!push) return { pushed: false }
  const { shadow_mode } = await getState()
  if (shadow_mode) return { pushed: false }

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
  return { pushed: delivered > 0 }
}
