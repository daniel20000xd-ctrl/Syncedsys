import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/daemon/auth'
import { reflectionJob, schedulerTick } from '@/lib/daemon/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Manual trigger: bypasses quiet hours, the due check and the once-a-night guard.
// Still honours the kill switch, the cost cap and the lock.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production' && process.env.DAEMON_DEBUG_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const type = req.nextUrl.searchParams.get('type')
  if (type !== 'heartbeat' && type !== 'reflection') {
    return NextResponse.json({ error: 'type must be heartbeat or reflection' }, { status: 400 })
  }
  const { status, body } = type === 'heartbeat'
    ? await schedulerTick({ force: true })
    : await reflectionJob({ force: true })
  return NextResponse.json(body, { status })
}
