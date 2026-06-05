import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { readRange, writeRange } from '@/lib/google/sheets'

// Local Sheets values API used by the GoogleSheetsPortal (browser cookie session).
// GET reads a range; POST writes a 2D array of values. Both require a session.

async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

// GET ?spreadsheetId=&range= — read a range, returns { values }.
export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const spreadsheetId = searchParams.get('spreadsheetId')
  const range = searchParams.get('range')
  if (!spreadsheetId || !range) {
    return NextResponse.json({ error: 'spreadsheetId and range are required' }, { status: 400 })
  }

  try {
    const values = await readRange(userId, spreadsheetId, range)
    return NextResponse.json({ values })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Read failed' }, { status: 502 })
  }
}

// POST { spreadsheetId, range, values } — write a 2D array of values.
export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { spreadsheetId?: string; range?: string; values?: (string | number)[][] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
  if (!body.spreadsheetId || !body.range || !Array.isArray(body.values)) {
    return NextResponse.json({ error: 'spreadsheetId, range and values are required' }, { status: 400 })
  }

  try {
    const result = await writeRange(userId, body.spreadsheetId, body.range, body.values)
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Write failed' }, { status: 502 })
  }
}
