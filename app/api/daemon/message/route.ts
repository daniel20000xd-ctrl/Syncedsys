import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDeviceAuthorized } from '@/lib/daemon/auth'
import { acquireLock, getDaemonUserId, getState, releaseLock } from '@/lib/daemon/state'
import { drainPendingInput, runInput } from '@/lib/daemon/calls'
import { isOverBudget } from '@/lib/daemon/usage'
import { sendBudgetAlert } from '@/lib/daemon/alert'
import { localDate } from '@/lib/daemon/time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BUSY = "Busy for a second — I'll pick this up in a moment."
const DISABLED = "I'm switched off right now — your message is saved and I'll pick it up when I'm back on."
const OVER_BUDGET = "Daily cost cap reached — your message is saved and I'll pick it up once the cap resets."
const MAX_CONTENT = 20_000
// Messages that arrived mid-call are drained here only if this invocation clearly has
// time left; otherwise the next scheduler tick picks them up.
const DRAIN_IF_ELAPSED_UNDER_MS = 10_000

const queued = (reply: string) => NextResponse.json({ reply, queued: true }, { status: 202 })

export async function POST(req: NextRequest) {
  const started = Date.now()
  if (!isDeviceAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })
  if (content.length > MAX_CONTENT) return NextResponse.json({ error: `content exceeds ${MAX_CONTENT} chars` }, { status: 413 })

  let userId: string
  try {
    userId = await getDaemonUserId()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
  const admin = createAdminClient()

  // Persist before anything else can fail: an inbound message is never dropped. The
  // pending row stays unprocessed until a model call has actually answered it.
  const { error: queueErr } = await admin.from('daemon_pending_input').insert({ user_id: userId, content })
  if (queueErr) return NextResponse.json({ error: `failed to save message: ${queueErr.message}` }, { status: 500 })
  const { error: logErr } = await admin.from('daemon_interaction_log')
    .insert({ user_id: userId, direction: 'in', call_type: 'input', content })
  if (logErr) console.error('[daemon/message] interaction log insert failed:', logErr.message)

  let reply: string | null = null
  try {
    const state = await getState()
    if (!state.enabled) return queued(DISABLED)
    if (await isOverBudget()) {
      await sendBudgetAlert(localDate(), 'Daily cost cap reached; inbound messages are being queued.')
      return queued(OVER_BUDGET)
    }

    const lock = await acquireLock('input')
    if (!lock) return queued(BUSY)
    try {
      reply = (await runInput(userId, { push: false }))?.reply ?? null
    } finally {
      await releaseLock(lock)
    }
  } catch (e) {
    console.error('[daemon/message] input call failed:', (e as Error).message)
  }

  if (Date.now() - started < DRAIN_IF_ELAPSED_UNDER_MS) {
    await drainPendingInput(userId).catch(e => console.error('[daemon/message] drain failed:', (e as Error).message))
  }

  // null: the call failed (the message stays queued for the scheduler to retry), or a
  // concurrent call already answered it and pushed the reply.
  if (reply === null) return queued(BUSY)
  return NextResponse.json({ reply, queued: false })
}
