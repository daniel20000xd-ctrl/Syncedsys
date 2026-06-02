import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Board, List, Card, BoardElement, BoardEdge } from '@/lib/types'
import BoardView from '@/components/BoardView'
import FreeBoardView from '@/components/free/FreeBoardView'
import TextBoardView from '@/components/TextBoardView'
import FolderBoardView from '@/components/FolderBoardView'
import SpreadsheetBoardView from '@/components/SpreadsheetBoardView'
import { resetDueRecurringCards } from '@/lib/recur'

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  // One round trip for the board + everything attached to it; sub-boards in
  // parallel. RLS scopes all of it to the owner, so no getUser() hop needed.
  const [boardRes, subRes] = await Promise.all([
    supabase
      .from('boards')
      .select('*, lists(*, cards(*)), board_elements(*), board_edges(*)')
      .eq('id', id)
      .single(),
    supabase
      .from('boards')
      .select('*')
      .eq('parent_id', id)
      .order('tab_position', { ascending: true }),
  ])

  const board = boardRes.data
  if (!board) notFound()

  const lists = ((board.lists ?? []) as List[]).slice().sort((a, b) => a.position - b.position)
  const cards = lists.flatMap(l => ((l as unknown as { cards?: Card[] }).cards ?? [])).slice().sort((a, b) => a.position - b.position)
  const elements = (board.board_elements ?? []) as BoardElement[]
  const edges = (board.board_edges ?? []) as BoardEdge[]
  const subBoards = (subRes.data ?? []) as Board[]

  // Recurring cards: reset any whose interval has elapsed since completion.
  await resetDueRecurringCards(supabase, cards)

  if (board.mode === 'classic' || (board.mode as string) === 'free') {
    return (
      <FreeBoardView
        board={board}
        initialLists={lists}
        initialCards={cards}
        initialEdges={edges}
        initialElements={elements}
        initialSubBoards={subBoards}
      />
    )
  }

  if (board.mode === 'text') {
    return <TextBoardView board={board} />
  }

  if (board.mode === 'spreadsheet') {
    return <SpreadsheetBoardView board={board} />
  }

  if (board.mode === 'folder') {
    const fileElements = elements.filter(e => e.type === 'textfile')
    return (
      <FolderBoardView
        board={board}
        initialFolders={subBoards}
        initialFiles={fileElements}
      />
    )
  }

  return <BoardView board={board} initialLists={lists} initialCards={cards} />
}
