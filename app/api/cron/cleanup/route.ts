import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Called daily by Vercel cron (vercel.json). Deletes anything past its deadline.
// Vercel automatically passes CRON_SECRET as an Authorization header.
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = new Date().toISOString()

  const [boards, lists, cards, elements] = await Promise.all([
    admin.from('boards').delete().lt('deadline', now).not('deadline', 'is', null).select('id'),
    admin.from('lists').delete().lt('deadline', now).not('deadline', 'is', null).select('id'),
    admin.from('cards').delete().lt('deadline', now).not('deadline', 'is', null).select('id'),
    admin.from('board_elements').delete().lt('deadline', now).not('deadline', 'is', null).select('id'),
  ])

  // Recurring cards backstop: reset any completed recurring card whose interval
  // has elapsed. (Boards that get opened reset lazily on load; this catches the
  // rest.) We fetch candidates and filter in JS since the cutoff is per-row.
  const { data: recurring } = await admin
    .from('cards')
    .select('id, done, done_at, recur_interval_minutes')
    .eq('done', true)
    .not('recur_interval_minutes', 'is', null)

  const nowMs = Date.now()
  const due = (recurring ?? []).filter(
    c => c.done_at != null && new Date(c.done_at).getTime() + c.recur_interval_minutes * 60_000 <= nowMs,
  )
  if (due.length > 0) {
    await admin.from('cards').update({ done: false, done_at: null }).in('id', due.map(c => c.id))
  }

  const summary = {
    boards: boards.data?.length ?? 0,
    lists: lists.data?.length ?? 0,
    cards: cards.data?.length ?? 0,
    elements: elements.data?.length ?? 0,
    recurReset: due.length,
  }

  console.log('[cron/cleanup]', new Date().toISOString(), summary)
  return NextResponse.json({ deleted: summary })
}
