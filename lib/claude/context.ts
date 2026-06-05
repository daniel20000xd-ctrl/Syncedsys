import type { SupabaseClient } from '@supabase/supabase-js'
import { formatCalendarContext } from '@/lib/google/calendar'
import { formatSheetsContext } from '@/lib/google/sheets'
import { formatDocsContext } from '@/lib/google/docs'

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
  accessToken?: string,
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

  const systemContext = await renderContext(supabase, rootBoardId, allowedIds, boardById, childrenByParent, linkTargetsByBoard, accessToken)
  return { allowedIds, rootId: rootBoardId, systemContext }
}

async function renderContext(
  supabase: SupabaseClient,
  rootId: string,
  allowedIds: Set<string>,
  boardById: Map<string, BoardRow>,
  childrenByParent: Map<string, BoardRow[]>,
  linkTargetsByBoard: Map<string, string[]>,
  accessToken?: string,
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

  // Pre-fetch slides context for all slides portals (async, before the sync tree walk).
  const slidesCtxMap = new Map<string, string>()
  if (accessToken) {
    const slidesPortals = elRows.filter(
      e => e.type === 'portal' && (e.data?.viewerKind as string | undefined) === 'slides'
    )
    await Promise.all(slidesPortals.map(async e => {
      const presId = (e.data?.viewerConfig as { presentationId?: string } | undefined)?.presentationId
      if (!presId) return
      try {
        const resp = await fetch(
          `https://slides.syncedsys.com/api/slides/context/${presId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (resp.ok) slidesCtxMap.set(e.id, await resp.text())
      } catch {}
    }))
  }

  // Pre-fetch the user's Google Calendar summary once if any google-calendar
  // portal is in scope (the summary is per-user, not per-portal).
  let googleCalendarCtx: string | null = null
  if (elRows.some(e => e.type === 'portal' && (e.data?.viewerKind as string | undefined) === 'google-calendar')) {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) googleCalendarCtx = await formatCalendarContext(user.id)
    } catch {}
  }

  // Pre-fetch each google-sheets portal's summary (per-portal — depends on its
  // configured spreadsheetId / active sheet).
  const sheetsCtxMap = new Map<string, string>()
  const sheetsPortals = elRows.filter(e => e.type === 'portal' && (e.data?.viewerKind as string | undefined) === 'google-sheets')
  if (sheetsPortals.length) {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await Promise.all(sheetsPortals.map(async e => {
          const cfg = e.data?.viewerConfig as { spreadsheetId?: string; activeSheet?: string } | undefined
          if (!cfg?.spreadsheetId) return
          try { sheetsCtxMap.set(e.id, await formatSheetsContext(user.id, cfg.spreadsheetId, cfg.activeSheet)) } catch {}
        }))
      }
    } catch {}
  }

  // Pre-fetch each google-docs portal's summary (per-portal — depends on its documentId).
  const docsCtxMap = new Map<string, string>()
  const docsPortals = elRows.filter(e => e.type === 'portal' && (e.data?.viewerKind as string | undefined) === 'google-docs')
  if (docsPortals.length) {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await Promise.all(docsPortals.map(async e => {
          const cfg = e.data?.viewerConfig as { documentId?: string } | undefined
          if (!cfg?.documentId) return
          try { docsCtxMap.set(e.id, await formatDocsContext(user.id, cfg.documentId)) } catch {}
        }))
      }
    } catch {}
  }

  const lines: string[] = []
  const seen = new Set<string>()

  function describeBoard(id: string, depth: number, via: 'child' | 'portal' | 'root') {
    if (seen.has(id)) { lines.push(`${'  '.repeat(depth)}- [${boardById.get(id)?.name ?? id}] (already listed above — id ${id})`); return }
    seen.add(id)
    const b = boardById.get(id)
    if (!b) return
    const indent = '  '.repeat(depth)
    const tag = via === 'portal'
      ? ' (reached via portal)'
      : via === 'root'
        ? ' ← CURRENT BOARD (the user is viewing this one)'
        : ''
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
        if (d.viewerKind === 'google-docs') {
          const docsCtx = docsCtxMap.get(e.id) ?? (d.viewer_context ? String(d.viewer_context) : null)
          if (docsCtx) {
            lines.push(`${indent}    element[${e.id}]: google-docs-viewer`)
            lines.push(`${indent}    ---BEGIN GOOGLE DOCS DATA---`)
            for (const vline of docsCtx.split('\n')) lines.push(`${indent}    ${vline}`)
            lines.push(`${indent}    ---END GOOGLE DOCS DATA---`)
            continue
          }
          label = `google-docs-viewer (no document)`
        } else if (d.viewerKind === 'google-sheets') {
          const sheetsCtx = sheetsCtxMap.get(e.id) ?? (d.viewer_context ? String(d.viewer_context) : null)
          if (sheetsCtx) {
            lines.push(`${indent}    element[${e.id}]: google-sheets-viewer`)
            lines.push(`${indent}    ---BEGIN GOOGLE SHEETS DATA---`)
            for (const vline of sheetsCtx.split('\n')) lines.push(`${indent}    ${vline}`)
            lines.push(`${indent}    ---END GOOGLE SHEETS DATA---`)
            continue
          }
          label = `google-sheets-viewer (no spreadsheet)`
        } else if (d.viewerKind === 'google-calendar') {
          const calCtx = googleCalendarCtx ?? (d.viewer_context ? String(d.viewer_context) : null)
          if (calCtx) {
            lines.push(`${indent}    element[${e.id}]: google-calendar-viewer`)
            lines.push(`${indent}    ---BEGIN GOOGLE CALENDAR DATA---`)
            for (const vline of calCtx.split('\n')) lines.push(`${indent}    ${vline}`)
            lines.push(`${indent}    ---END GOOGLE CALENDAR DATA---`)
            continue
          }
          label = `google-calendar-viewer (not connected)`
        } else if (d.viewerKind === 'slides') {
          const slidesCtx = slidesCtxMap.get(e.id) ?? (d.viewer_context ? String(d.viewer_context) : null)
          if (slidesCtx) {
            lines.push(`${indent}    element[${e.id}]: slides-viewer`)
            lines.push(`${indent}    ---BEGIN SLIDES DATA---`)
            for (const vline of slidesCtx.split('\n')) lines.push(`${indent}    ${vline}`)
            lines.push(`${indent}    ---END SLIDES DATA---`)
            continue
          }
          label = `slides-viewer (no presentation selected)`
        } else if (d.viewerKind && d.viewer_context) {
          lines.push(`${indent}    element[${e.id}]: viewer-portal (${d.viewerKind ?? 'unknown'})`)
          lines.push(`${indent}    ---BEGIN VIEWER DATA---`)
          for (const vline of String(d.viewer_context).split('\n')) {
            lines.push(`${indent}    ${vline}`)
          }
          lines.push(`${indent}    ---END VIEWER DATA---`)
          continue
        } else {
          label = `portal → ${d.targetBoardId ?? '(unset)'}`
        }
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
