import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDeviceAuthorized } from '@/lib/daemon/auth'
import { getDaemonUserId } from '@/lib/daemon/state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!isDeviceAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const params = req.nextUrl.searchParams
  const since = params.get('since')
  if (since && Number.isNaN(Date.parse(since))) return NextResponse.json({ error: 'since must be ISO-8601' }, { status: 400 })
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '50', 10) || 50, 1), 200)

  try {
    const userId = await getDaemonUserId()
    const base = createAdminClient()
      .from('daemon_interaction_log')
      .select('id, direction, content, created_at')
      .eq('user_id', userId)
      .neq('call_type', 'system')

    // With `since`: the next page forward from that point. Without: the latest page.
    const { data, error } = since
      ? await base.gt('created_at', new Date(since).toISOString()).order('created_at', { ascending: true }).limit(limit)
      : await base.order('created_at', { ascending: false }).limit(limit)
    if (error) throw new Error(error.message)

    const messages = since ? data ?? [] : (data ?? []).reverse()
    return NextResponse.json({ messages }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
