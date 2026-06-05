import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { formatCalendarContext } from '@/lib/google/calendar'

// GET /api/google/calendar/context — plain-text summary of the next 30 days,
// formatted for Claude. Requires a Supabase session.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const text = await formatCalendarContext(user.id)
    return new NextResponse(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : 'Calendar context failed', { status: 502 })
  }
}
