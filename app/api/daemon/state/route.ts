import { NextRequest, NextResponse } from 'next/server'
import { isDeviceAuthorized } from '@/lib/daemon/auth'
import { getDaemonUserId, getState } from '@/lib/daemon/state'
import { loadActive } from '@/lib/daemon/context'
import { readLatest, readRange, renderBlocks } from '@/lib/daemon/files'
import { addDays, localDate } from '@/lib/daemon/time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!isDeviceAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const userId = await getDaemonUserId()
    const today = localDate()
    const [state, active, latest, calendar] = await Promise.all([
      getState(),
      loadActive(userId),
      readLatest(userId, 'reflection'),
      readRange(userId, 'calendar', today, addDays(today, 7), today),
    ])
    return NextResponse.json({
      active: active.map(a => ({
        id: a.id, type: a.type, title: a.title, content: a.content, status: a.status,
        deadline: a.deadline, tags: a.tags, last_nudged_at: a.last_nudged_at,
      })),
      todays_log: latest ? renderBlocks('', [latest]) : '',
      calendar: renderBlocks('', calendar),
      shadow_mode: state.shadow_mode,
      next_wake_time: state.next_wake_time,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
