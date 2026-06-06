import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function RootPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: boards } = await supabase
    .from('boards')
    .select('id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)

  if (boards && boards.length > 0) {
    redirect(`/board/${boards[0].id}`)
  }

  // New user — seed a welcome board with two sticky notes
  const { data: board, error } = await supabase
    .from('boards')
    .insert({ name: 'My First Board', color: '#6366f1', user_id: user.id, tab_position: 0, mode: 'classic' })
    .select()
    .single()

  if (!error && board) {
    const id1 = crypto.randomUUID()
    const id2 = crypto.randomUUID()
    await supabase.from('board_elements').insert([
      {
        id: id1, board_id: board.id, type: 'text', x: 160, y: 200, width: 200, height: 160,
        data: { text: 'This is your first board!\n\nFollow the arrow to get started.', bgColor: 'rgba(254,240,64,0.95)', fontSize: 14, color: '#1f2937' },
      },
      {
        id: id2, board_id: board.id, type: 'text', x: 420, y: 200, width: 200, height: 160,
        data: { text: 'Enjoy mapping out everything!', bgColor: 'rgba(254,240,64,0.95)', fontSize: 14, color: '#1f2937' },
      },
    ])
    await supabase.from('board_edges').insert({
      board_id: board.id,
      source: `el-${id1}`,
      target: `el-${id2}`,
      source_handle: 'right',
      target_handle: 'left',
      data: {},
    })
    redirect(`/board/${board.id}`)
  }

  redirect('/boards')
}
