import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

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

  await admin.from('device_links').update({ last_seen: new Date().toISOString() }).eq('id', link.id)

  const { data: boards } = await admin
    .from('boards')
    .select('*')
    .eq('user_id', link.user_id)
    .eq('synced', true)
    .order('tab_position', { ascending: true })

  const boardIds = (boards ?? []).map(b => b.id)
  const [lists, elements] = boardIds.length
    ? await Promise.all([
        admin.from('lists').select('*').in('board_id', boardIds),
        admin.from('board_elements').select('*').in('board_id', boardIds),
      ])
    : [{ data: [] }, { data: [] }]

  const listIds = (lists.data ?? []).map(l => l.id)
  const cards = listIds.length
    ? (await admin.from('cards').select('*').in('list_id', listIds)).data ?? []
    : []

  return NextResponse.json({
    syncedAt: new Date().toISOString(),
    boards: boards ?? [],
    lists: lists.data ?? [],
    cards,
    elements: elements.data ?? [],
  })
}
