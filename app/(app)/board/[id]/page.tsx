import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import BoardView from '@/components/BoardView'

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: board } = await supabase
    .from('boards')
    .select('*')
    .eq('id', id)
    .eq('user_id', user!.id)
    .single()

  if (!board) notFound()

  const { data: lists } = await supabase
    .from('lists')
    .select('*')
    .eq('board_id', id)
    .order('position', { ascending: true })

  const { data: cards } = await supabase
    .from('cards')
    .select('*')
    .in('list_id', (lists ?? []).map(l => l.id))
    .order('position', { ascending: true })

  return <BoardView board={board} initialLists={lists ?? []} initialCards={cards ?? []} />
}
