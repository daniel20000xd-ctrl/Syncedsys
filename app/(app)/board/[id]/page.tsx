import { notFound, redirect } from 'next/navigation'
import dynamic from 'next/dynamic'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Board, List, Card, BoardElement, BoardEdge } from '@/lib/types'
import { resetDueRecurringCards } from '@/lib/recur'
import { isClaudeEnabled } from '@/lib/mcp'
import BoardDesktop from '@/components/BoardDesktop'
import { isAdminEmail } from '@/lib/admin'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const supabase = await createClient()

  // select('*') (not an explicit is_persona column) so this never errors on the
  // pre-migration schema — is_persona simply reads undefined there.
  const { data: board } = await supabase
    .from('boards')
    .select('*')
    .eq('id', id)
    .single()

  if (!board) return {}

  // Walk up to the top-level tab, stopping BEFORE the persona (the persona is a
  // container, not the board context the title should show).
  let root = board
  while (root.parent_id) {
    const { data: parent } = await supabase
      .from('boards')
      .select('*')
      .eq('id', root.parent_id)
      .single()
    if (!parent || parent.is_persona) break
    root = parent
  }

  return { title: root.name }
}

// Code-split each board view so a tab only ships the JS for its own mode —
// notably, the heavy React Flow canvas bundle loads only for classic boards.
const BoardView = dynamic(() => import('@/components/BoardView'))
const FreeBoardView = dynamic(() => import('@/components/free/FreeBoardView'))
const TextBoardView = dynamic(() => import('@/components/TextBoardView'))
const FolderBoardView = dynamic(() => import('@/components/FolderBoardView'))
const DatabaseBoardViewWrapper = dynamic(() => import('@/components/DatabaseBoardViewWrapper'))
const ClaudeAgent = dynamic(() => import('@/components/claude/ClaudeAgent'))
const BoardReadme = dynamic(() => import('@/components/BoardReadme'))

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  // Resolve the current user first — needed to choose the query client.
  const { data: { user } } = await supabase.auth.getUser()
  const isAdmin = isAdminEmail(user?.email)

  // Admins use the service-role client so they can view any user's boards.
  // Regular users use their session client (RLS scopes queries to the owner).
  const queryClient = isAdmin ? createAdminClient() : supabase

  const [boardRes, subRes, claudeEnabled] = await Promise.all([
    queryClient
      .from('boards')
      .select('*, lists(*, cards(*)), board_elements(*), board_edges(*)')
      .eq('id', id)
      .single(),
    queryClient
      .from('boards')
      .select('*')
      .eq('parent_id', id)
      .order('tab_position', { ascending: true }),
    isClaudeEnabled(supabase),
  ])

  const board = boardRes.data
  if (!board) notFound()

  // Personas aren't navigable as boards — redirect into the persona's first tab.
  if (board.is_persona) {
    const first = (subRes.data ?? [])[0] as Board | undefined
    redirect(first ? `/board/${first.id}` : '/boards')
  }

  // Admin viewing someone else's board → read-only (no writes, no Claude).
  const readOnly = isAdmin && board.user_id !== user?.id

  const lists = ((board.lists ?? []) as List[]).slice().sort((a, b) => a.position - b.position)
  const cards = lists.flatMap(l => ((l as unknown as { cards?: Card[] }).cards ?? [])).slice().sort((a, b) => a.position - b.position)
  const elements = (board.board_elements ?? []) as BoardElement[]
  const edges = (board.board_edges ?? []) as BoardEdge[]
  const subBoards = (subRes.data ?? []) as Board[]

  // The Claude chat mounts when the user has their own key OR the workspace has a
  // platform key to fall back on (billed to the user). Keep this in sync with the
  // resolver in lib/claude/key.ts.
  const showClaude = !readOnly && (claudeEnabled || !!process.env.ANTHROPIC_API_KEY)

  // Recurring cards: reset any whose interval has elapsed since completion.
  // Skip for read-only admin views — don't mutate another user's data.
  if (!readOnly) {
    await resetDueRecurringCards(supabase, cards)
  }

  let view
  if (board.mode === 'classic' || (board.mode as string) === 'free') {
    view = (
      <div className="flex flex-col h-full overflow-hidden">
        {board.readme_enabled && (
          <BoardReadme boardId={board.id} initialReadme={board.readme_md ?? null} onDark />
        )}
        <div className="flex-1 min-h-0">
          <FreeBoardView
            board={board}
            initialLists={lists}
            initialCards={cards}
            initialEdges={edges}
            initialElements={elements}
            initialSubBoards={subBoards}
            isAdmin={isAdmin}
            readOnly={readOnly}
          />
        </div>
      </div>
    )
  } else if (board.mode === 'text') {
    view = <BoardDesktop board={board}><TextBoardView board={board} /></BoardDesktop>
  } else if (board.mode === 'folder') {
    const fileElements = elements.filter(e => e.type === 'textfile' || e.type === 'pdf' || e.type === 'file')
    view = <BoardDesktop board={board}><FolderBoardView board={board} initialFolders={subBoards} initialFiles={fileElements} /></BoardDesktop>
  } else if (board.mode === 'database') {
    view = isAdmin
      ? <BoardDesktop board={board}><DatabaseBoardViewWrapper boardId={board.id} config={board.content ?? ''} initialReadme={board.readme_md ?? null} /></BoardDesktop>
      : <BoardDesktop board={board}><div className="flex-1 flex items-center justify-center text-sm text-gray-400">Not available</div></BoardDesktop>
  } else {
    view = <BoardDesktop board={board}><BoardView board={board} initialLists={lists} initialCards={cards} /></BoardDesktop>
  }

  if (readOnly) {
    return (
      <div className="relative h-full flex flex-col overflow-hidden">
        <div className="flex-none flex items-center justify-center py-1 bg-amber-500 text-white text-xs font-semibold select-none">
          Admin view — read only
        </div>
        <div className="flex-1 min-h-0">
          {view}
        </div>
      </div>
    )
  }

  return (
    <>
      {view}
      {showClaude && <ClaudeAgent boardId={board.id} />}
    </>
  )
}
