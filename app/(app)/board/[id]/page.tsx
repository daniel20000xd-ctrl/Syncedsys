import { notFound } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/server'
import type { Board, List, Card, BoardElement, BoardEdge } from '@/lib/types'
import { resetDueRecurringCards } from '@/lib/recur'

// Code-split each board view so a tab only ships the JS for its own mode —
// notably, the heavy React Flow canvas bundle loads only for classic boards.
const BoardView = dynamic(() => import('@/components/BoardView'))
const FreeBoardView = dynamic(() => import('@/components/free/FreeBoardView'))
const TextBoardView = dynamic(() => import('@/components/TextBoardView'))
const FolderBoardView = dynamic(() => import('@/components/FolderBoardView'))
const SpreadsheetBoardView = dynamic(() => import('@/components/SpreadsheetBoardView'))
const ClaudeAgent = dynamic(() => import('@/components/claude/ClaudeAgent'))

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

  let view
  if (board.mode === 'classic' || (board.mode as string) === 'free') {
    view = (
      <FreeBoardView
        board={board}
        initialLists={lists}
        initialCards={cards}
        initialEdges={edges}
        initialElements={elements}
        initialSubBoards={subBoards}
      />
    )
  } else if (board.mode === 'text') {
    view = <TextBoardView board={board} />
  } else if (board.mode === 'spreadsheet') {
    view = <SpreadsheetBoardView board={board} />
  } else if (board.mode === 'folder') {
    const fileElements = elements.filter(e => e.type === 'textfile' || e.type === 'pdf')
    view = <FolderBoardView board={board} initialFolders={subBoards} initialFiles={fileElements} />
  } else {
    view = <BoardView board={board} initialLists={lists} initialCards={cards} />
  }

  return (
    <>
      {view}
      <ClaudeAgent boardId={board.id} />
    </>
  )
}
