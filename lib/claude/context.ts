import type { SupabaseClient } from '@supabase/supabase-js'

// Builds the permission boundary and the system context for a board-scoped Claude.
//
// Scope rule (hard, always enforced): starting from the root board, Claude may
// reach the root + all descendants (via parent_id) + any board a portal/
// folder-link in the reachable set points to, plus THOSE boards' descendants.
// Traversal only ever goes DOWN (into children / portal targets), never up to a
// parent. Cycles are handled via a visited set.

type BoardRow = {
  id: string
  name: string
  color: string
  mode: string
  parent_id: string | null
  content: string | null
}

type ElementRow = {
  id: string
  board_id: string
  type: string
  data: Record<string, unknown> | null
}

export type ClaudeContext = {
  allowedIds: Set<string>
  rootId: string
  systemContext: string
}

export async function buildClaudeContext(
  supabase: SupabaseClient,
  rootBoardId: string,
): Promise<ClaudeContext> {
  // Load all of the user's boards once (RLS scopes to the owner) and all
  // portal/folder-link elements so we can resolve cross-references in memory.
  const [{ data: boardsRaw }, { data: elsRaw }] = await Promise.all([
    supabase.from('boards').select('id,name,color,mode,parent_id,content'),
    supabase.from('board_elements').select('id,board_id,type,data').in('type', ['portal', 'folderlink']),
  ])
  const boards = (boardsRaw ?? []) as BoardRow[]
  const portalEls = (elsRaw ?? []) as ElementRow[]

  const boardById = new Map(boards.map(b => [b.id, b]))
  const childrenByParent = new Map<string, BoardRow[]>()
  for (const b of boards) {
    if (b.parent_id) {
      const arr = childrenByParent.get(b.parent_id) ?? []
      arr.push(b)
      childrenByParent.set(b.parent_id, arr)
    }
  }
  // Portal / folder-link targets per board.
  const linkTargetsByBoard = new Map<string, string[]>()
  for (const el of portalEls) {
    const tid = (el.data?.targetBoardId as string | undefined) ?? undefined
    if (!tid) continue
    const arr = linkTargetsByBoard.get(el.board_id) ?? []
    arr.push(tid)
    linkTargetsByBoard.set(el.board_id, arr)
  }

  // BFS down from the root, following children + link targets.
  const allowedIds = new Set<string>()
  const queue: string[] = [rootBoardId]
  while (queue.length) {
    const id = queue.shift()!
    if (allowedIds.has(id)) continue
    if (!boardById.has(id)) continue // ignore dangling references / not owned
    allowedIds.add(id)
    for (const child of childrenByParent.get(id) ?? []) queue.push(child.id)
    for (const tid of linkTargetsByBoard.get(id) ?? []) queue.push(tid)
  }

  const systemContext = await renderContext(supabase, rootBoardId, allowedIds, boardById, childrenByParent, linkTargetsByBoard)
  return { allowedIds, rootId: rootBoardId, systemContext }
}

async function renderContext(
  supabase: SupabaseClient,
  rootId: string,
  allowedIds: Set<string>,
  boardById: Map<string, BoardRow>,
  childrenByParent: Map<string, BoardRow[]>,
  linkTargetsByBoard: Map<string, string[]>,
): Promise<string> {
  const ids = [...allowedIds]
  // Pull the lightweight contents for every in-scope board.
  const [{ data: lists }, { data: cards }, { data: elements }] = await Promise.all([
    supabase.from('lists').select('id,board_id,name').in('board_id', ids),
    // cards join through lists; fetch by list ids below
    Promise.resolve({ data: [] as { id: string; list_id: string; title: string; done: boolean }[] }),
    supabase.from('board_elements').select('id,board_id,type,data').in('board_id', ids),
  ])
  const listRows = (lists ?? []) as { id: string; board_id: string; name: string }[]
  const listIds = listRows.map(l => l.id)
  const cardRows = listIds.length
    ? ((await supabase.from('cards').select('id,list_id,title,done').in('list_id', listIds)).data ?? [])
    : []
  const elRows = (elements ?? []) as ElementRow[]

  const listsByBoard = new Map<string, typeof listRows>()
  for (const l of listRows) { const a = listsByBoard.get(l.board_id) ?? []; a.push(l); listsByBoard.set(l.board_id, a) }
  const cardsByList = new Map<string, typeof cardRows>()
  for (const c of cardRows) { const a = cardsByList.get(c.list_id) ?? []; a.push(c); cardsByList.set(c.list_id, a) }
  const elsByBoard = new Map<string, ElementRow[]>()
  for (const e of elRows) { const a = elsByBoard.get(e.board_id) ?? []; a.push(e); elsByBoard.set(e.board_id, a) }

  const lines: string[] = []
  const seen = new Set<string>()

  function describeBoard(id: string, depth: number, via: 'child' | 'portal' | 'root') {
    if (seen.has(id)) { lines.push(`${'  '.repeat(depth)}- [${boardById.get(id)?.name ?? id}] (already listed above — id ${id})`); return }
    seen.add(id)
    const b = boardById.get(id)
    if (!b) return
    const indent = '  '.repeat(depth)
    const tag = via === 'portal' ? ' (reached via portal)' : ''
    lines.push(`${indent}- "${b.name}" [mode=${b.mode}, id=${b.id}]${tag}`)

    // Contents summary by mode.
    if (b.mode === 'text' || b.mode === 'spreadsheet') {
      const body = (b.content ?? '').slice(0, 1500)
      if (body.trim()) lines.push(`${indent}    content: ${JSON.stringify(body)}`)
    }
    const bls = listsByBoard.get(b.id) ?? []
    for (const l of bls) {
      const cs = cardsByList.get(l.id) ?? []
      const cardStr = cs.map(c => `${c.done ? '✓' : '·'} ${c.title}`).join('; ')
      lines.push(`${indent}    list "${l.name}": ${cardStr || '(empty)'}`)
    }
    const bels = elsByBoard.get(b.id) ?? []
    for (const e of bels) {
      const d = e.data ?? {}
      let label = e.type
      if (e.type === 'text') label = `text: ${JSON.stringify(String(d.text ?? '').slice(0, 120))}`
      else if (e.type === 'shape') label = `shape(${d.shape ?? 'rect'}) "${d.label ?? ''}"`
      else if (e.type === 'textfile') label = `file "${d.name ?? 'untitled'}"`
      else if (e.type === 'pdf') {
        const excerpt = String(d.text ?? '').slice(0, 6000)
        label = `pdf "${d.name ?? 'document'}" (${d.pageCount ?? '?'} pages)` +
          (excerpt.trim() ? `:\n${indent}      text: ${JSON.stringify(excerpt)}` : ' (no extractable text)')
      }
      else if (e.type === 'portal') {
        if (d.viewerKind && d.viewer_context) {
          // Viewer portal: include the full live data block so Claude has zero info loss
          lines.push(`${indent}    element[${e.id}]: viewer-portal (${d.viewerKind ?? 'unknown'})`)
          lines.push(`${indent}    ---BEGIN VIEWER DATA---`)
          for (const vline of String(d.viewer_context).split('\n')) {
            lines.push(`${indent}    ${vline}`)
          }
          lines.push(`${indent}    ---END VIEWER DATA---`)
          continue
        }
        label = `portal → ${d.targetBoardId ?? '(unset)'}`
      }
      else if (e.type === 'folderlink') label = `folder-link "${d.name ?? ''}" → ${d.targetBoardId ?? '?'}`
      lines.push(`${indent}    element[${e.id}]: ${label}`)
    }

    // Recurse into children, then portal targets.
    for (const child of childrenByParent.get(id) ?? []) {
      if (allowedIds.has(child.id)) describeBoard(child.id, depth + 1, 'child')
    }
    for (const tid of linkTargetsByBoard.get(id) ?? []) {
      if (allowedIds.has(tid)) describeBoard(tid, depth + 1, 'portal')
    }
  }

  describeBoard(rootId, 0, 'root')

  return [
    'You are operating inside a single board ("tab") and the boards reachable downward from it.',
    'Here is the current state of everything you can see and act on:',
    '',
    ...lines,
    '',
    'You may ONLY read or modify boards listed above (identified by their id).',
    'Never attempt to touch a parent board or any board not listed here.',
  ].join('\n')
}
