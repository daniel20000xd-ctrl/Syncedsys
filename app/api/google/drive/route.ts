import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { listDriveFiles, DRIVE_MIME, type DriveKind } from '@/lib/google/drive'

// GET ?type=document|spreadsheet|presentation&q=<search> → the user's matching
// Drive files, newest first. Powers the Docs/Sheets portal file pickers.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const type = (searchParams.get('type') ?? 'document') as DriveKind
  const mimeType = DRIVE_MIME[type] ?? DRIVE_MIME.document
  const search = searchParams.get('q') ?? undefined

  try {
    const files = await listDriveFiles(user.id, { mimeType, search })
    return NextResponse.json({ files })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to list files' },
      { status: 502 },
    )
  }
}
