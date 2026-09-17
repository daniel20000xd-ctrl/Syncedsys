import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/daemon/auth'
import { metaJob, reflectionJob, schedulerTick } from '@/lib/daemon/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOBS = {
  heartbeat: () => schedulerTick({ force: true }),
  reflection: () => reflectionJob({ force: true }),
  meta: () => metaJob({ force: true }),
}

// Manual trigger: bypasses quiet hours, the due check and the once-a-night/week guards.
// Still honours the kill switch, the cost cap and the lock.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production' && process.env.DAEMON_DEBUG_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const type = req.nextUrl.searchParams.get('type')
  if (type !== 'heartbeat' && type !== 'reflection' && type !== 'meta') {
    return NextResponse.json({ error: 'type must be heartbeat, reflection or meta' }, { status: 400 })
  }
  const { status, body } = await JOBS[type]()
  return NextResponse.json(body, { status })
}
