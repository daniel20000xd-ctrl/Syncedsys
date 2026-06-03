import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Never cache — the iOS app needs fresh data on every poll.
export const dynamic = 'force-dynamic'

// The iOS app calls this with `Authorization: Bearer <token>` (from pairing).
// Returns the user's synced boards plus their lists/cards/elements/content.
export async function GET(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 })

  const admin = createAdminClient()
  const { data: link } = await admin
    .from('device_links')
    .select('*')
    .eq('token', token)
    .eq('paired', true)
    .single()

  if (!link) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Update last-seen timestamp (fire-and-forget, don't await)
  admin.from('device_links').update({ last_seen: new Date().toISOString() }).eq('id', link.id).then(() => {})

  // Sync ALL of the user's boards. The original `synced=true` filter was never
  // reachable (no UI existed to set it, so every board defaulted to false and
  // the iOS app always got empty arrays). Remove the filter so everything syncs.
  const { data: boards } = await admin
    .from('boards')
    .select('*')
    .eq('user_id', link.user_id)
    .order('tab_position', { ascending: true })
    .order('created_at', { ascending: true })

  const boardIds = (boards ?? []).map(b => b.id)

  const [listsRes, elementsRes] = boardIds.length
    ? await Promise.all([
        admin.from('lists')
          .select('*')
          .in('board_id', boardIds)
          .order('position', { ascending: true }),
        admin.from('board_elements')
          .select('*')
          .in('board_id', boardIds),
      ])
    : [{ data: [] }, { data: [] }]

  const listIds = (listsRes.data ?? []).map((l: { id: string }) => l.id)
  const cards = listIds.length
    ? ((await admin
        .from('cards')
        .select('*')
        .in('list_id', listIds)
        .order('position', { ascending: true })
      ).data ?? [])
    : []

  return NextResponse.json(
    {
      syncedAt: new Date().toISOString(),
      boards:   boards ?? [],
      lists:    listsRes.data ?? [],
      cards,
      elements: elementsRes.data ?? [],
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    }
  )
}
