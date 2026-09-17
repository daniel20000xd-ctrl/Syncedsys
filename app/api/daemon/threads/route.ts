import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDeviceAuthorized } from '@/lib/daemon/auth'
import { getDaemonUserId } from '@/lib/daemon/state'
import { latestMessages, type Thread } from '@/lib/daemon/threads'
import { truncateForPush } from '@/lib/daemon/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!isDeviceAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const limit = Math.min(Math.max(Number.parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10) || 50, 1), 200)

  try {
    const userId = await getDaemonUserId()
    const { data, error } = await createAdminClient()
      .from('daemon_threads')
      .select('*')
      .eq('user_id', userId)
      .order('last_activity_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    const threads = (data ?? []) as Thread[]
    const last = await latestMessages(threads.map(t => t.id))

    return NextResponse.json({
      threads: threads.map(t => {
        const l = last.get(t.id)
        return {
          id: t.id,
          topic: t.topic,
          status: t.status,
          opened_by: t.opened_by,
          expects_reply: t.expects_reply,
          last_activity_at: t.last_activity_at,
          last_message_preview: l ? truncateForPush(l.content) : null,
          // Unread-ish: the daemon spoke last on a thread that isn't closed.
          unread: !!l && l.direction === 'out' && t.status !== 'closed',
        }
      }),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
