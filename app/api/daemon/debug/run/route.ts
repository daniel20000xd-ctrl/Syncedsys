import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/daemon/auth'
import { metaJob, reflectionJob, schedulerTick } from '@/lib/daemon/jobs'
import { debugAllowed, dryRun, DRY_RUN_TYPES } from '@/lib/daemon/dryrun'
import type { PromptKind } from '@/lib/daemon/prompts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOBS = {
  heartbeat: () => schedulerTick({ force: true }),
  reflection: () => reflectionJob({ force: true }),
  meta: () => metaJob({ force: true }),
}
const PROMPT_KINDS = ['system', 'input', 'heartbeat', 'reflection', 'meta']

// Manual trigger: bypasses quiet hours, the due check and the once-a-night/week guards.
// Still honours the kill switch, the cost cap and the lock.
//
// Dry run: ?type=<call>&dry_run=1 with an optional JSON body
// { "override": { "kind": "...", "content": "..." }, "message": "..." } returns what the
// model would answer without applying or persisting anything (see lib/daemon/dryrun.ts).
export async function POST(req: NextRequest) {
  if (!debugAllowed()) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const type = req.nextUrl.searchParams.get('type')

  if (req.nextUrl.searchParams.get('dry_run') === '1') {
    if (!DRY_RUN_TYPES.includes(type as (typeof DRY_RUN_TYPES)[number])) {
      return NextResponse.json({ error: 'type must be input, heartbeat, reflection or meta' }, { status: 400 })
    }
    const body = await req.json().catch(() => ({}))
    const override = body.override
    if (override != null && (!PROMPT_KINDS.includes(override.kind) || typeof override.content !== 'string')) {
      return NextResponse.json({ error: 'override must be { kind, content }' }, { status: 400 })
    }
    try {
      const result = await dryRun({
        callType: type as (typeof DRY_RUN_TYPES)[number],
        override: override ? { kind: override.kind as PromptKind, content: override.content } : undefined,
        message: typeof body.message === 'string' ? body.message : undefined,
      })
      return NextResponse.json(result)
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
  }

  if (type !== 'heartbeat' && type !== 'reflection' && type !== 'meta') {
    return NextResponse.json({ error: 'type must be heartbeat, reflection or meta' }, { status: 400 })
  }
  const { status, body } = await JOBS[type]()
  return NextResponse.json(body, { status })
}
