import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/daemon/auth'
import { metaJob } from '@/lib/daemon/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Driven weekly by .github/workflows/daemon-cron.yml. Returns 409 { retry: true } if the
// lock stays held; the workflow retries.
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { status, body } = await metaJob()
  return NextResponse.json(body, { status })
}
