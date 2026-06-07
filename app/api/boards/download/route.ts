import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildBoardZip } from '@/lib/exportZip'

// Build R2 fetches + an in-memory ZIP — needs the Node runtime and headroom.
export const runtime = 'nodejs'
export const maxDuration = 60

// POST { boardId } → a ZIP that mirrors the board's whole subtab/folder tree.
// Each board is a directory; its soft units become one markdown file and its
// file units (text/PDF/blobs) become real files. RLS + user_id scope the walk.
export async function POST(req: NextRequest) {
  let body: { boardId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
  const boardId = body.boardId
  if (!boardId) return NextResponse.json({ error: 'boardId is required' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let result: Awaited<ReturnType<typeof buildBoardZip>>
  try {
    result = await buildBoardZip(supabase, user.id, boardId)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Export failed' }, { status: 500 })
  }
  if (!result) return NextResponse.json({ error: 'Board not found' }, { status: 404 })

  // ASCII-safe fallback + RFC 5987 UTF-8 name (handles e.g. "migrationsrätt").
  const asciiName = result.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  const utf8Name = encodeURIComponent(result.filename)

  // result.bytes is already a Uint8Array — pass it straight through (no re-copy).
  return new Response(result.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'Content-Length': String(result.bytes.length),
      'Cache-Control': 'no-store',
    },
  })
}
