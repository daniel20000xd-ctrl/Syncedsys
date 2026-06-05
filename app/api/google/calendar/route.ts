import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  type GoogleCalendarMeta,
  type CalendarEventInput,
} from '@/lib/google/calendar'

// Local Calendar API used by the GoogleCalendarPortal (browser, cookie session)
// and indirectly by the Claude tools. Every handler requires a Supabase session.

async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

type NormalizedEvent = {
  id: string
  calendarId: string
  calendarName: string
  color: string
  title: string
  description: string
  start: string
  end: string
  allDay: boolean
}

function normalize(ev: Record<string, unknown>, cal: GoogleCalendarMeta): NormalizedEvent {
  const start = ev.start as { dateTime?: string; date?: string } | undefined
  const end = ev.end as { dateTime?: string; date?: string } | undefined
  return {
    id: String(ev.id),
    calendarId: cal.id,
    calendarName: cal.summary,
    color: cal.backgroundColor,
    title: String(ev.summary ?? '(no title)'),
    description: String(ev.description ?? ''),
    start: String(start?.dateTime ?? start?.date ?? ''),
    end: String(end?.dateTime ?? end?.date ?? ''),
    allDay: !!start?.date,
  }
}

// GET ?start=&end=&calendarId= — events in range. Without calendarId, merges
// events from ALL of the user's calendars, each tagged with its calendar colour.
export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  const calendarId = searchParams.get('calendarId')
  if (!start || !end) return NextResponse.json({ error: 'start and end are required' }, { status: 400 })

  try {
    const calendars = await listCalendars(userId)
    const wanted = calendarId ? calendars.filter(c => c.id === calendarId) : calendars
    const lists = await Promise.all(
      wanted.map(async cal => {
        try {
          const items = await listEvents(userId, cal.id, start, end)
          return items.map(ev => normalize(ev, cal))
        } catch {
          return [] as NormalizedEvent[]
        }
      }),
    )
    return NextResponse.json({ calendars, events: lists.flat() })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Calendar fetch failed' }, { status: 502 })
  }
}

// POST { calendarId, event } — create an event.
export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { calendarId?: string; event?: CalendarEventInput }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
  if (!body.event) return NextResponse.json({ error: 'event is required' }, { status: 400 })

  try {
    const created = await createEvent(userId, body.calendarId || 'primary', body.event)
    return NextResponse.json(created)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Create failed' }, { status: 502 })
  }
}

// PATCH { calendarId, eventId, changes } — update an event.
export async function PATCH(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { calendarId?: string; eventId?: string; changes?: CalendarEventInput }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
  if (!body.eventId || !body.changes) {
    return NextResponse.json({ error: 'eventId and changes are required' }, { status: 400 })
  }

  try {
    const updated = await updateEvent(userId, body.calendarId || 'primary', body.eventId, body.changes)
    return NextResponse.json(updated)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Update failed' }, { status: 502 })
  }
}

// DELETE { calendarId, eventId } — delete an event.
export async function DELETE(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { calendarId?: string; eventId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
  if (!body.eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  try {
    await deleteEvent(userId, body.calendarId || 'primary', body.eventId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Delete failed' }, { status: 502 })
  }
}
