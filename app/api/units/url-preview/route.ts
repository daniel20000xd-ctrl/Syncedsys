import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createUrlPreviewUnit, UrlPreviewError } from '@/lib/urlPreview'

// Canonical action endpoint: create a url_preview unit on a board AND enrich it.
// Body: { boardId, url, x?, y? }. Used by programmatic callers (the MCP tool can
// also call createUrlPreview directly). Validation/SSRF failures return 400.
export async function POST(req: NextRequest) {
  let body: { boardId?: string; url?: string; x?: number; y?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  const { boardId, url, x, y } = body
  if (!boardId || !url) {
    return NextResponse.json({ error: 'boardId and url are required' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const { id, data } = await createUrlPreviewUnit({ supabase, userId: user.id, boardId, url, x, y })
    return NextResponse.json({ id, data })
  } catch (e) {
    if (e instanceof UrlPreviewError) return NextResponse.json({ error: e.message }, { status: 400 })
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to create preview' }, { status: 500 })
  }
}
