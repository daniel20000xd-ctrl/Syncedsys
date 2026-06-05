import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { readSpreadsheetMetadata } from '@/lib/google/sheets'

// GET /api/google/sheets/metadata?spreadsheetId= — title + sheet tabs + properties.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const spreadsheetId = searchParams.get('spreadsheetId')
  if (!spreadsheetId) return NextResponse.json({ error: 'spreadsheetId is required' }, { status: 400 })

  try {
    const meta = await readSpreadsheetMetadata(user.id, spreadsheetId)
    return NextResponse.json(meta)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Metadata failed' }, { status: 502 })
  }
}
