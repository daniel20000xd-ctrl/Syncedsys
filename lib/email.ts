import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = 'Syncedsys Calendar <calendar@syncedsys.com>'

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export async function sendReminderEmail(
  to: string,
  event: { title: string; start_at: string; end_at: string | null; description: string | null },
  minutesBefore: number,
) {
  const when = minutesBefore >= 1440
    ? 'tomorrow'
    : minutesBefore >= 60
    ? `in ${minutesBefore / 60} hour${minutesBefore / 60 === 1 ? '' : 's'}`
    : `in ${minutesBefore} minute${minutesBefore === 1 ? '' : 's'}`

  const subject = `Reminder: ${event.title} ${when}`

  const lines = [
    `<b>${event.title}</b>`,
    `<br>Start: ${fmtTime(event.start_at)}`,
    event.end_at ? `<br>End: ${fmtTime(event.end_at)}` : '',
    event.description ? `<br><br>${event.description}` : '',
  ].filter(Boolean).join('')

  await resend.emails.send({ from: FROM, to, subject, html: `<p>${lines}</p>` })
}

export async function sendConflictEmail(
  to: string,
  newEvent: { title: string; start_at: string; end_at: string | null },
  conflicts: Array<{ id: string; title: string; start_at: string; end_at: string | null }>,
) {
  const subject = `Calendar conflict: "${newEvent.title}" overlaps ${conflicts.length} event${conflicts.length === 1 ? '' : 's'}`

  const conflictLines = conflicts
    .map(c => `<li><b>${c.title}</b> — ${fmtTime(c.start_at)}${c.end_at ? ` to ${fmtTime(c.end_at)}` : ''}</li>`)
    .join('')

  const html = `
    <p>Your event <b>${newEvent.title}</b> (${fmtTime(newEvent.start_at)}${newEvent.end_at ? ` to ${fmtTime(newEvent.end_at)}` : ''})
    was created but overlaps with:</p>
    <ul>${conflictLines}</ul>
    <p>Both events have been registered. You may want to reschedule one of them.</p>
  `

  await resend.emails.send({ from: FROM, to, subject, html })
}
