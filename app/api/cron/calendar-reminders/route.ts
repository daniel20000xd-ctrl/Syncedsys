import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendReminderEmail } from '@/lib/email'

const INTERVAL_MINUTES = 5

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = new Date()
  const windowEnd = new Date(now.getTime() + INTERVAL_MINUTES * 60000)

  // Load unsent reminders joined to their events
  const { data: reminders, error } = await admin
    .from('calendar_reminders')
    .select(`
      id,
      minutes_before,
      custom_message,
      user_id,
      calendar_events (
        title,
        start_at,
        end_at,
        description
      )
    `)
    .is('sent_at', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!reminders?.length) return NextResponse.json({ sent: 0 })

  // For each reminder, compute trigger_time = start_at - minutes_before
  type EventShape = { title: string; start_at: string; end_at: string | null; description: string | null }

  const due = reminders.filter(r => {
    const event = (r.calendar_events as unknown) as EventShape | null
    if (!event) return false
    const trigger = new Date(new Date(event.start_at).getTime() - r.minutes_before * 60000)
    return trigger >= now && trigger <= windowEnd
  })

  // Resolve user emails and send
  let sent = 0
  const ids: string[] = []

  for (const r of due) {
    const event = (r.calendar_events as unknown) as EventShape | null
    if (!event) continue

    const { data: userData } = await admin.auth.admin.getUserById(r.user_id)
    const email = userData?.user?.email
    if (!email) continue

    try {
      await sendReminderEmail(email, event, r.minutes_before, r.custom_message ?? undefined)
      ids.push(r.id)
      sent++
    } catch {
      // continue — don't block other reminders if one send fails
    }
  }

  if (ids.length) {
    await admin
      .from('calendar_reminders')
      .update({ sent_at: now.toISOString() })
      .in('id', ids)
  }

  return NextResponse.json({ sent })
}
