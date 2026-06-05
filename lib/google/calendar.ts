import { googleFetch } from '@/lib/google/client'

// Google Calendar operations for the shared ecosystem. Every call goes through
// googleFetch, which injects a valid access token for the user and refreshes on
// 401 — so nothing here ever touches tokens directly.

const CAL_BASE = 'https://www.googleapis.com/calendar/v3'

export type GoogleCalendarMeta = {
  id: string
  summary: string
  primary: boolean
  backgroundColor: string
  foregroundColor: string
}

// The portal/tool-facing event shape. start/end are ISO datetimes for timed
// events, or YYYY-MM-DD when allDay.
export type CalendarEventInput = {
  title?: string
  description?: string
  start?: string
  end?: string
  allDay?: boolean
}

async function calJson(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  const res = await googleFetch(userId, `${CAL_BASE}${path}`, init)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Google Calendar ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`)
  }
  if (res.status === 204) return null
  const text = await res.text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : null
}

function toRfc3339(value: string): string {
  const d = new Date(value)
  return isNaN(d.getTime()) ? value : d.toISOString()
}

// Build a Google event resource from the simplified input. Only fields that are
// present are emitted, so the same mapper works for create and partial update.
function toGoogleEvent(input: CalendarEventInput): Record<string, unknown> {
  const ev: Record<string, unknown> = {}
  if (input.title !== undefined) ev.summary = input.title
  if (input.description !== undefined) ev.description = input.description
  if (input.start !== undefined) ev.start = input.allDay ? { date: input.start } : { dateTime: toRfc3339(input.start) }
  if (input.end !== undefined) ev.end = input.allDay ? { date: input.end } : { dateTime: toRfc3339(input.end) }
  return ev
}

export async function listCalendars(userId: string): Promise<GoogleCalendarMeta[]> {
  const data = await calJson(userId, '/users/me/calendarList')
  const items = (data?.items ?? []) as Array<Record<string, unknown>>
  return items.map(it => ({
    id: String(it.id),
    summary: String(it.summaryOverride ?? it.summary ?? it.id),
    primary: !!it.primary,
    backgroundColor: String(it.backgroundColor ?? '#4285f4'),
    foregroundColor: String(it.foregroundColor ?? '#ffffff'),
  }))
}

export async function listEvents(
  userId: string,
  calendarId: string,
  startDate: string,
  endDate: string,
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({
    timeMin: toRfc3339(startDate),
    timeMax: toRfc3339(endDate),
    singleEvents: 'true', // expand recurring events into instances
    orderBy: 'startTime',
    maxResults: '2500',
  })
  const data = await calJson(userId, `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`)
  return (data?.items ?? []) as Array<Record<string, unknown>>
}

export async function createEvent(
  userId: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<Record<string, unknown> | null> {
  return calJson(userId, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toGoogleEvent(event)),
  })
}

export async function updateEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  changes: CalendarEventInput,
): Promise<Record<string, unknown> | null> {
  return calJson(userId, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toGoogleEvent(changes)),
  })
}

export async function deleteEvent(
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<{ ok: true }> {
  await calJson(userId, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  })
  return { ok: true }
}

function fmtDateTime(iso?: string): string {
  if (!iso) return '?'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function fmtTime(iso?: string): string {
  if (!iso) return '?'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Plain-text summary of the next 30 days across every calendar, formatted for
// Claude to read inside the board context.
export async function formatCalendarContext(userId: string): Promise<string> {
  const now = new Date()
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const calendars = await listCalendars(userId)

  const lines: string[] = []
  lines.push(`Google Calendar — upcoming events ${now.toDateString()} → ${in30.toDateString()} (next 30 days).`)
  lines.push(`Calendars: ${calendars.map(c => c.summary).join(', ') || '(none)'}`)
  lines.push('')

  const rows: { when: number; text: string }[] = []
  for (const cal of calendars) {
    let items: Array<Record<string, unknown>> = []
    try {
      items = await listEvents(userId, cal.id, now.toISOString(), in30.toISOString())
    } catch {
      continue
    }
    for (const ev of items) {
      const start = ev.start as { dateTime?: string; date?: string } | undefined
      const end = ev.end as { dateTime?: string; date?: string } | undefined
      const summary = String(ev.summary ?? '(no title)')
      const allDay = !!start?.date
      const startStr = start?.dateTime ?? start?.date ?? ''
      const when = startStr ? new Date(startStr).getTime() : 0
      const label = allDay
        ? `${start?.date} (all day)`
        : `${fmtDateTime(start?.dateTime)} – ${fmtTime(end?.dateTime)}`
      const loc = ev.location ? ` @ ${String(ev.location)}` : ''
      rows.push({ when, text: `- ${label} · ${summary}${loc} [${cal.summary}]` })
    }
  }
  rows.sort((a, b) => a.when - b.when)
  if (rows.length === 0) lines.push('(no upcoming events in the next 30 days)')
  else for (const r of rows) lines.push(r.text)

  return lines.join('\n')
}
