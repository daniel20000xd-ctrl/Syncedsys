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

  const summary = {
    boards: boards.data?.length ?? 0,
    lists: lists.data?.length ?? 0,
    cards: cards.data?.length ?? 0,
    elements: elements.data?.length ?? 0,
  }

  console.log('[cron/cleanup]', new Date().toISOString(), summary)
  return NextResponse.json({ deleted: summary })
}
