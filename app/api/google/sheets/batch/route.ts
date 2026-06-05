import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { batchUpdate } from '@/lib/google/sheets'

// POST /api/google/sheets/batch { spreadsheetId, requests } — structural /
// formatting changes (insert/delete rows & columns, formatting, add sheet, …).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { spreadsheetId?: string; requests?: unknown[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
  if (!body.spreadsheetId || !Array.isArray(body.requests)) {
    return NextResponse.json({ error: 'spreadsheetId and requests are required' }, { status: 400 })
  }

  try {
    const result = await batchUpdate(user.id, body.spreadsheetId, body.requests)
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Batch update failed' }, { status: 502 })
  }
}
