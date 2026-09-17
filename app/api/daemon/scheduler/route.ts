import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/daemon/auth'
import { schedulerTick } from '@/lib/daemon/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Driven every 5 minutes by .github/workflows/daemon-cron.yml (Vercel Hobby can't run
// sub-daily crons). Quiet hours are enforced in code against DAEMON_TZ.
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { status, body } = await schedulerTick()
  return NextResponse.json(body, { status })
}
