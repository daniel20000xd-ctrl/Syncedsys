import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDeviceAuthorized } from '@/lib/daemon/auth'
import { getDaemonUserId, getState } from '@/lib/daemon/state'
import { loadActive } from '@/lib/daemon/context'
import { readRange, renderBlocks } from '@/lib/daemon/files'
import { assembleDayLog } from '@/lib/daemon/daylog'
import { getLatestNotes } from '@/lib/daemon/notes'
import { listProposals } from '@/lib/daemon/proposals'
import { addDays, localDate } from '@/lib/daemon/time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!isDeviceAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const userId = await getDaemonUserId()
    const today = localDate()
    const [state, active, todaysLog, calendar, notes, openThreads, openProposals] = await Promise.all([
      getState(),
      loadActive(userId),
      assembleDayLog(userId, today),
      readRange(userId, 'calendar', today, addDays(today, 7), today),
      getLatestNotes(userId),
      createAdminClient().from('daemon_threads')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('status', 'open'),
      listProposals(userId, { verdicts: ['open'] }),
    ])
    if (openThreads.error) throw new Error(openThreads.error.message)
    return NextResponse.json({
      active: active.map(a => ({
        id: a.id, type: a.type, title: a.title, content: a.content, status: a.status,
        deadline: a.deadline, tags: a.tags, last_nudged_at: a.last_nudged_at,
      })),
      todays_log: todaysLog,
      calendar: renderBlocks('', calendar),
      operating_notes: notes?.content ?? '',
      open_threads: openThreads.count ?? 0,
      open_proposals: openProposals.length,
      proposals: openProposals.map(p => ({
        id: p.id, category: p.category, direction: p.direction, title: p.title, body: p.body,
        verdict: p.verdict, created_at: p.created_at,
      })),
      shadow_mode: state.shadow_mode,
      next_wake_time: state.next_wake_time,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
