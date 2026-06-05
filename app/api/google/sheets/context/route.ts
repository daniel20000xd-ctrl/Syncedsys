import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { formatSheetsContext } from '@/lib/google/sheets'

// GET /api/google/sheets/context?spreadsheetId=&sheet= — plain-text summary for Claude.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const spreadsheetId = searchParams.get('spreadsheetId')
  const sheet = searchParams.get('sheet') ?? undefined
  if (!spreadsheetId) return NextResponse.json({ error: 'spreadsheetId is required' }, { status: 400 })

  try {
    const text = await formatSheetsContext(user.id, spreadsheetId, sheet)
    return new NextResponse(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : 'Context failed', { status: 502 })
  }
}
