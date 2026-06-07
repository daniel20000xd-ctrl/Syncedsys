import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { enrichUrl, UrlPreviewError } from '@/lib/urlPreview'

// Self-healing endpoint: enrich a URL and RETURN the metadata. The client calls
// this for any url_preview unit it renders in `pending` state, then persists the
// result through the normal update flow (onSave -> updateElement) so local state
// and the DB stay consistent. Body: { unitId?, url }. The DB write is intentionally
// left to the client (which owns canvas state) to avoid double-writes / races.
export async function POST(req: NextRequest) {
  let body: { unitId?: string; url?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  const { unitId, url } = body
  if (!unitId || !url) return NextResponse.json({ error: 'unitId and url are required' }, { status: 400 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Anchor to an owned url_preview unit: enrich the URL stored on that row (RLS
  // scopes the lookup to the caller), never an arbitrary caller-supplied URL — so
  // this endpoint can't be abused as a generic authenticated server-side fetcher.
  const { data: row } = await supabase
    .from('board_elements')
    .select('type,data')
    .eq('id', unitId)
    .maybeSingle()
  if (!row || row.type !== 'url_preview') {
    return NextResponse.json({ error: 'Unit not found' }, { status: 404 })
  }
  const storedUrl = (row.data as { url?: string } | null)?.url
  const targetUrl = storedUrl || url

  try {
    const data = await enrichUrl(user.id, targetUrl)
    return NextResponse.json({ data })
  } catch (e) {
    if (e instanceof UrlPreviewError) return NextResponse.json({ error: e.message }, { status: 400 })
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to enrich preview' }, { status: 500 })
  }
}
