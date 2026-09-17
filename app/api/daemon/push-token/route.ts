import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDeviceAuthorized } from '@/lib/daemon/auth'
import { getDaemonUserId } from '@/lib/daemon/state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!isDeviceAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{32,200}$/.test(token)) return NextResponse.json({ error: 'token must be a hex string' }, { status: 400 })
  const environment = body.environment == null || body.environment === 'production'
    ? 'production'
    : body.environment === 'sandbox' ? 'sandbox' : null
  if (!environment) return NextResponse.json({ error: 'environment must be sandbox or production' }, { status: 400 })

  try {
    const userId = await getDaemonUserId()
    const { error } = await createAdminClient().from('daemon_push_tokens').upsert(
      { user_id: userId, device_token: token, platform: 'ios', environment, updated_at: new Date().toISOString() },
      { onConflict: 'device_token' },
    )
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
