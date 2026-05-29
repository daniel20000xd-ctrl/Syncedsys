import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import BoardView from '@/components/BoardView'
import FreeBoardView from '@/components/free/FreeBoardView'
import TextBoardView from '@/components/TextBoardView'

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

  if (board.mode === 'classic') {
    const { data: edges } = await supabase
      .from('board_edges')
      .select('*')
      .eq('board_id', id)

    const { data: elements } = await supabase
      .from('board_elements')
      .select('*')
      .eq('board_id', id)
      .order('created_at', { ascending: true })

    const { data: subBoards } = await supabase
      .from('boards')
      .select('*')
      .eq('parent_id', id)
      .order('tab_position', { ascending: true })

    return (
      <FreeBoardView
        board={board}
        initialLists={lists ?? []}
        initialCards={cards ?? []}
        initialEdges={edges ?? []}
        initialElements={elements ?? []}
        initialSubBoards={subBoards ?? []}
      />
    )
  }

  if (board.mode === 'text') {
    return <TextBoardView board={board} />
  }

  return <BoardView board={board} initialLists={lists ?? []} initialCards={cards ?? []} />
}
