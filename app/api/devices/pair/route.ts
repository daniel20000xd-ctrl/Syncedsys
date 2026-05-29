import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// iOS app pairs by POSTing the 6-char code the user generated in Settings.
// Returns a long-lived bearer token the app then uses against /api/sync.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const code = String(body.code ?? '').trim().toUpperCase()
  const name = typeof body.name === 'string' ? body.name : undefined
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })

  const admin = createAdminClient()
  const { data: link } = await admin
    .from('device_links')
    .select('*')
    .eq('pairing_code', code)
    .eq('paired', false)
    .single()

  if (!link) return NextResponse.json({ error: 'invalid or already-used code' }, { status: 404 })

  await admin
    .from('device_links')
    .update({ paired: true, pairing_code: null, last_seen: new Date().toISOString(), ...(name ? { name } : {}) })
    .eq('id', link.id)

  return NextResponse.json({ token: link.token, deviceId: link.id, userId: link.user_id })
}
