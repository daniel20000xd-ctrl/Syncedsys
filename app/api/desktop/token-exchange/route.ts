import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { mintSupabaseUserJwt } from '@/lib/crypto'

export const dynamic = 'force-dynamic'

// POST /api/desktop/token-exchange
// Body: { token: string }   ← the device bearer token from device_links
// Returns: { access_token, refresh_token }
//
// The desktop app calls this on every launch to exchange its long-lived device
// token for a 30-day Supabase JWT. Since we re-exchange on each launch the long
// TTL is fine — no refresh-token rotation needed.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token ?? '').trim()
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 })

  const admin = createAdminClient()

  const { data: link } = await admin
    .from('device_links')
    .select('user_id')
    .eq('token', token)
    .eq('paired', true)
    .single()

  if (!link) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // 30-day JWT — safe because the device token (persisted in OS credential store)
  // triggers a fresh exchange every time the app launches.
  const access_token = mintSupabaseUserJwt(link.user_id, 30 * 24 * 60 * 60)

  // Touch last_seen for device activity tracking (fire-and-forget)
  admin
    .from('device_links')
    .update({ last_seen: new Date().toISOString() })
    .eq('token', token)
    .then(() => {})

  // Return the device token itself as the refresh_token. Supabase JS will attempt
  // to use it when the 30-day JWT expires; that call will fail gracefully and the
  // next app launch will re-exchange anyway.
  return NextResponse.json({ access_token, refresh_token: token })
}
