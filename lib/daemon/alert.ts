import { Resend } from 'resend'
import { pushToAll } from './apns'
import { getState, updateState } from './state'
import { truncateForPush } from './notify'

const FROM = 'Syncedsys Daemon <daemon@syncedsys.com>'
// A persistently failing dependency would otherwise alert on every 5-minute tick.
const FAILURE_ALERT_COOLDOWN_MS = 60 * 60 * 1000

async function deliver(subject: string, detail: string): Promise<void> {
  const to = process.env.ADMIN_EMAIL?.trim()
  if (process.env.RESEND_API_KEY && to) {
    try {
      const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
        from: FROM, to, subject: `[daemon] ${subject}`, text: `${detail}\n\n${new Date().toISOString()}`,
      })
      if (!error) return
      console.error('[daemon/alert] email failed:', error.message)
    } catch (e) {
      console.error('[daemon/alert] email failed:', (e as Error).message)
    }
  }

  const state = await getState()
  // Shadow mode means no pushes at all, including failure pushes.
  if (!state.user_id || state.shadow_mode) {
    console.error('[daemon/alert] undelivered:', subject, detail)
    return
  }
  try {
    await pushToAll(state.user_id, {
      aps: { alert: { title: 'Daemon failure', body: truncateForPush(`${subject}: ${detail}`) }, sound: 'default' },
      kind: 'daemon_failure',
    })
  } catch (e) {
    console.error('[daemon/alert] push failed:', (e as Error).message, subject, detail)
  }
}

export async function sendFailureAlert(subject: string, detail: string): Promise<void> {
  try {
    const state = await getState()
    const last = state.last_failure_alert_at ? Date.parse(state.last_failure_alert_at) : 0
    if (Date.now() - last < FAILURE_ALERT_COOLDOWN_MS) return
    await updateState({ last_failure_alert_at: new Date().toISOString() })
    await deliver(subject, detail)
  } catch (e) {
    console.error('[daemon/alert] failed to alert:', (e as Error).message, subject, detail)
  }
}

// Once per local day.
export async function sendBudgetAlert(today: string, detail: string): Promise<void> {
  try {
    const state = await getState()
    if (state.budget_alert_day === today) return
    await updateState({ budget_alert_day: today })
    await deliver('daily cost cap reached', detail)
  } catch (e) {
    console.error('[daemon/alert] failed to alert:', (e as Error).message, detail)
  }
}
