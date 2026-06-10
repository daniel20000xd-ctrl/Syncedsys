import { NextRequest } from 'next/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { researchFetch } from '@/lib/research'
import { snapshotBefore, logAction } from '@/lib/mcp'
import { supabaseAuthContext } from '@/lib/supabase/authContext'
import { resolveMcpAuth } from '@/lib/mcpAuth'
import { tryResolveAnthropicKey } from '@/lib/claude/key'
import { recordClaudeUsage } from '@/lib/claude/usage'
import { claudeGate } from '@/lib/claude/gate'
import {
  createBoard, createGroup, moveTab, updateBoardFreePosition, updateBoardContent,
  createSubTab, deleteBoard, renameBoard, updateBoard, layoutBoardGrid, setBoardSynced,
  moveBoardToParent, copyBoardInto, ensureMirrorPortal, importFolderTree,
  createList, deleteList, renameList, setListWidget, setListDeadline, setListHidden, updateListPosition,
  createCard, deleteCard, updateCard, updateCardDone, setCardDeadline, setCardRecur, setCardHidden,
  moveCard, reorderCards, updateCardPosition, createFreeCard,
  createElement, updateElement, deleteElement, createTextFile, updateTextFile, createUrlPreview,
  moveElementToBoard, upsertElement, reorderFolderItems,
  createEdge, deleteEdge, updateEdgeShape, upsertEdge,
  getPdfUrl,
  createDeviceLink, removeDeviceLink,
  saveAnthropicKey, removeAnthropicKey, setClaudeAutoApply, getClaudeStatus,
  setStocksEnabled, getStocksEnabled,
  linkAccount, acceptLink, removeLink,
} from '@/app/actions'

export const dynamic = 'force-dynamic'

// ── Admin user ID cache (resolved once per cold start) ────────────────────────

let _adminUserId: string | null | undefined = undefined

async function getAdminUserId(): Promise<string | null> {
  if (_adminUserId !== undefined) return _adminUserId
  const admin = createAdminClient()
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  if (!adminEmail) { _adminUserId = null; return null }
  const { data } = await admin.auth.admin.listUsers()
  const user = data?.users?.find(u => u.email?.toLowerCase() === adminEmail)
  _adminUserId = user?.id ?? null
  return _adminUserId
}

// ── Shared types & helpers ────────────────────────────────────────────────────

type BoardMeta = { id: string; name: string; mode: string; meta: string | null }

const ELEMENT_TYPE = z.enum(['shape', 'image', 'drawing', 'text', 'portal', 'textfile', 'folderlink', 'claude', 'pdf', 'url_preview'])
const BOARD_MODE   = z.enum(['classic', 'trello', 'text', 'folder'])

function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}
function fail(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true as const }
}
async function wrap(fn: () => Promise<unknown>) {
  try { return ok(await fn() ?? { success: true }) }
  catch (e) { return fail(e instanceof Error ? e.message : String(e)) }
}

function formatBoards(boards: BoardMeta[]): string {
  if (boards.length === 0) return 'No boards found.'
  return boards
    .map(b => `• [${b.mode}] ${b.name}${b.meta ? ` — ${b.meta}` : ''} (id: ${b.id})`)
    .join('\n')
}

async function fetchBoards(supabase: SupabaseClient, userId: string): Promise<BoardMeta[] | null> {
  // select('*') + JS filter (rather than .eq('is_persona', false)) so this never
  // errors on the pre-migration schema; persona rows are excluded from context.
  const { data, error } = await supabase
    .from('boards').select('*').eq('user_id', userId)
    .order('tab_position', { ascending: true })
  if (error) return null
  return (data ?? []).filter(b => !(b as { is_persona?: boolean }).is_persona) as BoardMeta[]
}

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export async function suggestBoardMeta(
  name: string,
  mode: string,
  apiKey: string,
): Promise<{ suggestion: string; usage: Anthropic.Usage }> {
  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `Write a 1-2 sentence description for a board named "${name}" (mode: ${mode}). The description helps an AI assistant understand what this board is for. Be specific and concise. Reply with only the description, no quotes.`,
    }],
  })
  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
  return { suggestion: text.slice(0, 150), usage: response.usage }
}

// ── MCP server builder ────────────────────────────────────────────────────────

function buildServer(supabase: SupabaseClient, userId: string, adminUserId: string | null) {
  const server = new McpServer({ name: 'syncedsys', version: '1.0.0' })

  // Every write tool runs snapshotBefore + logAction before executing.
  // snapshot is optional — create operations have no pre-existing entity to capture.
  // affectedIds defaults to [snapshot.entityId] when not supplied explicitly.
  async function wrapWrite(
    tool: string,
    params: Record<string, unknown>,
    fn: () => Promise<unknown>,
    snapshot?: { entityType: string; entityId: string },
    affectedIds?: string[],
  ) {
    if (!userId) return fail('Not authenticated')
    const ids = affectedIds ?? (snapshot?.entityId ? [snapshot.entityId] : [])
    await Promise.all([
      snapshot?.entityId
        ? snapshotBefore(supabase, snapshot.entityType, snapshot.entityId, userId, tool)
        : Promise.resolve(),
      logAction(supabase, tool, params, ids, userId),
    ])
    return wrap(fn)
  }

  // ── AI / context tools (read-only) ──────────────────────────────────────────

  server.registerTool('get_boards_context', {
    title: 'Get boards context',
    description: 'Returns all boards for the authenticated user with name, mode, and AI description.',
    inputSchema: undefined,
  }, async () => {
    const boards = await fetchBoards(supabase, userId)
    if (!boards) return fail('Failed to fetch boards.')
    return ok(formatBoards(boards))
  })

  server.registerTool('find_relevant_boards', {
    title: 'Find relevant boards',
    description: 'Returns the 1–3 most relevant boards for a query, matched against name and description.',
    inputSchema: { query: z.string().describe('What the user is looking for') },
  }, async ({ query }) => {
    const [boards, resolved] = await Promise.all([fetchBoards(supabase, userId), tryResolveAnthropicKey(supabase, userId)])
    if (!boards) return fail('Failed to fetch boards.')
    if (!resolved)  return fail('No Anthropic API key. Add one in Settings.')
    const relGate = await claudeGate(supabase, userId, resolved.keySource)
    if (!relGate.ok) return fail(relGate.error === 'claude_disabled' ? 'Claude is temporarily unavailable.' : 'Free Claude credit for this month is used up — add your own API key or enable pay-per-use in Settings.')
    if (!boards.length) return ok([])
    const list = boards.map(b => `${b.id}\t${b.name}\t${b.meta ?? ''}`).join('\n')
    const response = await new Anthropic({ apiKey: resolved.apiKey }).messages.create({
      model: HAIKU_MODEL, max_tokens: 256,
      messages: [{ role: 'user', content: `Pick the 1-3 most relevant board IDs for: "${query}"\n\nBoards (id\\tname\\tdesc):\n${list}\n\nReply ONLY with a JSON array of IDs, e.g. ["id1"]. No explanation.` }],
    })
    await recordClaudeUsage({ userId, model: HAIKU_MODEL, keySource: resolved.keySource, usage: response.usage })
    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]'
    let ids: string[] = []
    try { ids = JSON.parse(raw) } catch { /* empty */ }
    return ok(boards.filter(b => ids.includes(b.id)).map(({ id, name, meta }) => ({ id, name, meta })))
  })

  server.registerTool('get_board_content', {
    title: 'Get board content',
    description: 'Returns full content for one board — lists, cards, and canvas elements.',
    inputSchema: { board_id: z.string().describe('Board ID') },
  }, async ({ board_id }) => {
    const { data: board } = await supabase.from('boards')
      .select('id,name,mode,meta,content,deadline').eq('id', board_id).eq('user_id', userId).maybeSingle()
    if (!board) return fail('Board not found or access denied.')
    const { data: lists } = await supabase.from('lists')
      .select('id,name,position,deadline,hidden').eq('board_id', board_id).order('position')
    const listRows = lists ?? []
    const listIds = listRows.map(l => l.id)
    const [cardsResult, elementsResult] = await Promise.all([
      listIds.length
        ? supabase.from('cards').select('id,list_id,title,description,done,done_at,deadline,position').in('list_id', listIds).order('position')
        : Promise.resolve({ data: [] }),
      supabase.from('board_elements').select('id,type,x,y,width,height,data,deadline').eq('board_id', board_id),
    ])
    const cardsByList = new Map<string, typeof cardsResult.data>()
    for (const c of cardsResult.data ?? []) {
      const b = cardsByList.get(c.list_id) ?? []; b.push(c); cardsByList.set(c.list_id, b)
    }
    const lines: string[] = []
    lines.push(`Board: "${board.name}" [mode=${board.mode}, id=${board.id}]`)
    if (board.meta) lines.push(`Description: ${board.meta}`)
    if (board.deadline) lines.push(`Deadline: ${board.deadline}`)
    lines.push('')
    if (listRows.length) {
      lines.push('## Lists')
      for (const l of listRows) {
        lines.push(`\n### ${l.name}${l.deadline ? ` (due ${l.deadline})` : ''}${l.hidden ? ' [hidden]' : ''}`)
        const cards = cardsByList.get(l.id) ?? []
        if (!cards.length) { lines.push('  (empty)'); continue }
        for (const c of cards) {
          lines.push(`  ${c.done ? '✓' : '·'} ${c.title}${c.deadline ? ` [due ${c.deadline.slice(0,10)}]` : ''}${c.done && c.done_at ? ` (done ${c.done_at.slice(0,10)})` : ''}`)
          if (c.description?.trim()) lines.push(`      ${c.description.trim()}`)
        }
      }
    }
    if (board.mode === 'text' && board.content?.trim()) {
      lines.push('\n## Content'); lines.push(board.content.slice(0, 3000))
    }
    const els = elementsResult.data ?? []
    if (els.length) {
      // Fields that carry no semantic value for an AI reader — large binary paths,
      // internal storage keys/URLs, and React callback props.
      const STRIP_KEYS = new Set(['strokes', 'drawing', 'storageKey', 'storageUrl', 'src', 'ogImage', 'home'])
      lines.push('\n## Canvas elements')
      for (const e of els) {
        const d = (e.data ?? {}) as Record<string, unknown>
        const pos = `pos=(${Math.round((e.x as number) ?? 0)},${Math.round((e.y as number) ?? 0)})`
        const sz = e.width != null ? ` size=${Math.round(e.width as number)}×${Math.round((e.height as number) ?? 0)}` : ''
        const due = e.deadline ? ` [due ${e.deadline.slice(0,10)}]` : ''
        lines.push(`  [${e.id}] type=${e.type} ${pos}${sz}${due}`)
        const payload = Object.fromEntries(
          Object.entries(d).filter(([k, v]) => !STRIP_KEYS.has(k) && typeof v !== 'function')
        )
        // Cap PDF extracted text so it doesn't dominate the response.
        if (e.type === 'pdf' && typeof payload.text === 'string' && payload.text.length > 3000) {
          payload.text = payload.text.slice(0, 3000) + '…'
        }
        if (Object.keys(payload).length) {
          lines.push(`    ${JSON.stringify(payload)}`)
        }
      }
    }
    return ok(lines.join('\n'))
  })

  server.registerTool('suggest_board_meta', {
    title: 'Suggest board description',
    description: 'Generates a short AI description for a board given its name and mode.',
    inputSchema: {
      name: z.string().describe('Board name'),
      mode: z.string().describe('Board mode'),
    },
  }, async ({ name, mode }) => {
    const resolved = await tryResolveAnthropicKey(supabase, userId)
    if (!resolved) return fail('No Anthropic API key. Add one in Settings.')
    const metaGate = await claudeGate(supabase, userId, resolved.keySource)
    if (!metaGate.ok) return fail(metaGate.error === 'claude_disabled' ? 'Claude is temporarily unavailable.' : 'Free Claude credit for this month is used up — add your own API key or enable pay-per-use in Settings.')
    const { suggestion, usage } = await suggestBoardMeta(name, mode, resolved.apiKey)
    await recordClaudeUsage({ userId, model: HAIKU_MODEL, keySource: resolved.keySource, usage })
    return ok(suggestion)
  })

  // ── Boards ──────────────────────────────────────────────────────────────────

  server.registerTool('create_board', {
    title: 'Create board',
    description: 'Creates a new top-level board tab.',
    inputSchema: {
      name:  z.string().describe('Board name'),
      color: z.string().describe('Hex color, e.g. #0079bf'),
      mode:  BOARD_MODE.optional().describe('Board mode (default: classic)'),
    },
  }, ({ name, color, mode }) => wrapWrite(
    'create_board', { name, color, mode },
    () => createBoard(name, color, mode),
  ))

  server.registerTool('create_group', {
    title: 'Create group',
    description: 'Creates a group container in the tab bar.',
    inputSchema: {
      name:          z.string(),
      color:         z.string(),
      mode:          z.enum(['folder', 'classic']),
      parentGroupId: z.string().nullable().optional().describe('Parent group ID, or null for top-level'),
    },
  }, ({ name, color, mode, parentGroupId }) => wrapWrite(
    'create_group', { name, color, mode, parentGroupId },
    () => createGroup(name, color, mode, parentGroupId ?? null),
    parentGroupId ? { entityType: 'board', entityId: parentGroupId } : undefined,
  ))

  server.registerTool('move_tab', {
    title: 'Move tab',
    description: 'Moves a tab into a group and/or reorders it.',
    inputSchema: {
      boardId:       z.string(),
      newGroupId:    z.string().nullable().describe('Target group ID, or null for top-level'),
      beforeBoardId: z.string().nullable().describe('Insert before this board ID, or null for end'),
    },
  }, ({ boardId, newGroupId, beforeBoardId }) => wrapWrite(
    'move_tab', { boardId, newGroupId, beforeBoardId },
    () => moveTab(boardId, newGroupId, beforeBoardId),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('update_board_free_position', {
    title: 'Update board free position',
    description: 'Sets the canvas position of a board in free (group-folder) mode.',
    inputSchema: { boardId: z.string(), x: z.number(), y: z.number() },
  }, ({ boardId, x, y }) => wrapWrite(
    'update_board_free_position', { boardId, x, y },
    () => updateBoardFreePosition(boardId, x, y),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('update_board_content', {
    title: 'Update board content',
    description: 'Overwrites the text content of a board.',
    inputSchema: { boardId: z.string(), content: z.string() },
  }, ({ boardId, content }) => wrapWrite(
    'update_board_content', { boardId },
    () => updateBoardContent(boardId, content),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('create_sub_tab', {
    title: 'Create sub-tab',
    description: 'Creates a child board under a parent board.',
    inputSchema: {
      parentBoardId: z.string(),
      name:  z.string(),
      color: z.string(),
      mode:  BOARD_MODE.optional(),
    },
  }, ({ parentBoardId, name, color, mode }) => wrapWrite(
    'create_sub_tab', { parentBoardId, name, color, mode },
    () => createSubTab(parentBoardId, name, color, mode),
    { entityType: 'board', entityId: parentBoardId },
  ))

  server.registerTool('delete_board', {
    title: 'Delete board',
    description: 'Permanently deletes a board and all its contents.',
    inputSchema: { boardId: z.string() },
  }, ({ boardId }) => wrapWrite(
    'delete_board', { boardId },
    () => deleteBoard(boardId),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('rename_board', {
    title: 'Rename board',
    description: 'Renames a board.',
    inputSchema: { boardId: z.string(), name: z.string() },
  }, ({ boardId, name }) => wrapWrite(
    'rename_board', { boardId, name },
    () => renameBoard(boardId, name),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('update_board', {
    title: 'Update board',
    description: 'Updates board properties: name, color, deadline, mode, meta.',
    inputSchema: {
      boardId:  z.string(),
      name:     z.string().optional(),
      color:    z.string().optional(),
      deadline: z.string().nullable().optional().describe('ISO date string or null'),
      mode:     BOARD_MODE.optional(),
      meta:     z.string().nullable().optional().describe('AI description (max 150 chars)'),
    },
  }, ({ boardId, ...updates }) => wrapWrite(
    'update_board', { boardId, ...updates },
    () => updateBoard(boardId, updates),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('layout_board_grid', {
    title: 'Layout board grid',
    description: 'Spreads a board\'s lists/cards into a kanban grid (use after switching Trello → Classic).',
    inputSchema: { boardId: z.string() },
  }, ({ boardId }) => wrapWrite(
    'layout_board_grid', { boardId },
    () => layoutBoardGrid(boardId),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('set_board_synced', {
    title: 'Set board synced',
    description: 'Toggles whether a board is included in iOS sync (true = included).',
    inputSchema: { boardId: z.string(), synced: z.boolean() },
  }, ({ boardId, synced }) => wrapWrite(
    'set_board_synced', { boardId, synced },
    () => setBoardSynced(boardId, synced),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('move_board_to_parent', {
    title: 'Move board to parent',
    description: 'Re-parents a board under another board, or to top-level when newParentId is null.',
    inputSchema: {
      boardId:      z.string(),
      newParentId:  z.string().nullable().describe('Target parent board ID, or null for top-level'),
      fromParentId: z.string().optional().describe('Current parent board ID (for cache revalidation)'),
    },
  }, ({ boardId, newParentId, fromParentId }) => wrapWrite(
    'move_board_to_parent', { boardId, newParentId, fromParentId },
    () => moveBoardToParent(boardId, newParentId, fromParentId),
    { entityType: 'board', entityId: boardId },
  ))

  server.registerTool('copy_board_into', {
    title: 'Copy board into',
    description: 'Deep-copies a board subtree (board + lists/cards/elements/edges + descendants) under a destination parent.',
    inputSchema: {
      sourceBoardId:     z.string(),
      destParentBoardId: z.string(),
      freeX: z.number().optional().describe('Canvas X position (default 100)'),
      freeY: z.number().optional().describe('Canvas Y position (default 100)'),
    },
  }, ({ sourceBoardId, destParentBoardId, freeX, freeY }) => wrapWrite(
    'copy_board_into', { sourceBoardId, destParentBoardId, freeX, freeY },
    () => copyBoardInto(sourceBoardId, destParentBoardId, freeX, freeY),
    { entityType: 'board', entityId: sourceBoardId },
    [sourceBoardId, destParentBoardId],
  ))

  server.registerTool('ensure_mirror_portal', {
    title: 'Ensure mirror portal',
    description: 'Ensures the target board has a portal pointing back to the source board.',
    inputSchema: { targetBoardId: z.string(), backBoardId: z.string() },
  }, ({ targetBoardId, backBoardId }) => wrapWrite(
    'ensure_mirror_portal', { targetBoardId, backBoardId },
    () => ensureMirrorPortal(targetBoardId, backBoardId),
    { entityType: 'board', entityId: targetBoardId },
    [targetBoardId, backBoardId],
  ))

  server.registerTool('import_folder_tree', {
    title: 'Import folder tree',
    description: 'Recreates a dropped folder tree under a parent board. Each folder becomes a child board (mode: folder) and each text file a textfile element.',
    inputSchema: {
      parentBoardId: z.string().describe('Parent board ID to import under'),
      tree: z.object({
        name:  z.string(),
        files: z.array(z.object({ name: z.string(), content: z.string() })),
        dirs:  z.array(z.unknown()),
      }).describe('Folder tree: { name, files: [{name, content}], dirs: [...recursive] }'),
      color: z.string().describe('Hex color for created folder boards'),
    },
  }, ({ parentBoardId, tree, color }) => wrapWrite(
    'import_folder_tree', { parentBoardId, color },
    () => importFolderTree(parentBoardId, tree as Parameters<typeof importFolderTree>[1], color),
    { entityType: 'board', entityId: parentBoardId },
  ))

  // ── Lists ───────────────────────────────────────────────────────────────────

  server.registerTool('create_list', {
    title: 'Create list',
    description: 'Creates a new list in a board.',
    inputSchema: {
      boardId: z.string(),
      name:    z.string(),
      id:      z.string().optional().describe('Optional explicit UUID'),
    },
  }, ({ boardId, name, id }) => wrapWrite(
    'create_list', { boardId, name, id },
    () => createList(boardId, name, id),
    undefined, [boardId],
  ))

  server.registerTool('delete_list', {
    title: 'Delete list',
    description: 'Deletes a list and all its cards.',
    inputSchema: { listId: z.string(), boardId: z.string() },
  }, ({ listId, boardId }) => wrapWrite(
    'delete_list', { listId, boardId },
    () => deleteList(listId, boardId),
    { entityType: 'list', entityId: listId },
  ))

  server.registerTool('rename_list', {
    title: 'Rename list',
    description: 'Renames a list.',
    inputSchema: { listId: z.string(), name: z.string(), boardId: z.string() },
  }, ({ listId, name, boardId }) => wrapWrite(
    'rename_list', { listId, name, boardId },
    () => renameList(listId, name, boardId),
    { entityType: 'list', entityId: listId },
  ))

  server.registerTool('set_list_widget', {
    title: 'Set list widget',
    description: 'Toggles whether a list is displayed as a widget.',
    inputSchema: { listId: z.string(), isWidget: z.boolean(), boardId: z.string() },
  }, ({ listId, isWidget, boardId }) => wrapWrite(
    'set_list_widget', { listId, isWidget, boardId },
    () => setListWidget(listId, isWidget, boardId),
    { entityType: 'list', entityId: listId },
  ))

  server.registerTool('set_list_deadline', {
    title: 'Set list deadline',
    description: 'Sets or clears the deadline on a list.',
    inputSchema: {
      listId:   z.string(),
      deadline: z.string().nullable().describe('ISO date string or null to clear'),
      boardId:  z.string(),
    },
  }, ({ listId, deadline, boardId }) => wrapWrite(
    'set_list_deadline', { listId, deadline, boardId },
    () => setListDeadline(listId, deadline, boardId),
    { entityType: 'list', entityId: listId },
  ))

  server.registerTool('set_list_hidden', {
    title: 'Set list hidden',
    description: 'Shows or hides a list.',
    inputSchema: { listId: z.string(), hidden: z.boolean(), boardId: z.string() },
  }, ({ listId, hidden, boardId }) => wrapWrite(
    'set_list_hidden', { listId, hidden, boardId },
    () => setListHidden(listId, hidden, boardId),
    { entityType: 'list', entityId: listId },
  ))

  server.registerTool('update_list_position', {
    title: 'Update list position',
    description: 'Sets the canvas X/Y position of a list (free-mode).',
    inputSchema: { listId: z.string(), x: z.number(), y: z.number() },
  }, ({ listId, x, y }) => wrapWrite(
    'update_list_position', { listId, x, y },
    () => updateListPosition(listId, x, y),
    { entityType: 'list', entityId: listId },
  ))

  // ── Cards ───────────────────────────────────────────────────────────────────

  server.registerTool('create_card', {
    title: 'Create card',
    description: 'Creates a new card in a list.',
    inputSchema: {
      listId:  z.string(),
      title:   z.string(),
      boardId: z.string(),
      id:      z.string().optional().describe('Optional explicit UUID'),
    },
  }, ({ listId, title, boardId, id }) => wrapWrite(
    'create_card', { listId, title, boardId, id },
    () => createCard(listId, title, boardId, id),
    undefined, [listId],
  ))

  server.registerTool('delete_card', {
    title: 'Delete card',
    description: 'Permanently deletes a card.',
    inputSchema: { cardId: z.string(), boardId: z.string() },
  }, ({ cardId, boardId }) => wrapWrite(
    'delete_card', { cardId, boardId },
    () => deleteCard(cardId, boardId),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('update_card', {
    title: 'Update card',
    description: 'Updates a card\'s title and/or description.',
    inputSchema: {
      cardId:      z.string(),
      boardId:     z.string(),
      title:       z.string().optional(),
      description: z.string().optional(),
    },
  }, ({ cardId, boardId, title, description }) => wrapWrite(
    'update_card', { cardId, boardId, title, description },
    () => updateCard(cardId, { title, description }, boardId),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('update_card_done', {
    title: 'Update card done',
    description: 'Marks a card as done or not done.',
    inputSchema: { cardId: z.string(), done: z.boolean(), boardId: z.string() },
  }, ({ cardId, done, boardId }) => wrapWrite(
    'update_card_done', { cardId, done, boardId },
    () => updateCardDone(cardId, done, boardId),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('set_card_deadline', {
    title: 'Set card deadline',
    description: 'Sets or clears a card\'s deadline (clears recurrence).',
    inputSchema: {
      cardId:   z.string(),
      deadline: z.string().nullable().describe('ISO date string or null to clear'),
      boardId:  z.string(),
    },
  }, ({ cardId, deadline, boardId }) => wrapWrite(
    'set_card_deadline', { cardId, deadline, boardId },
    () => setCardDeadline(cardId, deadline, boardId),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('set_card_recur', {
    title: 'Set card recurrence',
    description: 'Sets or clears the recurrence interval on a card (in minutes). Clears deadline.',
    inputSchema: {
      cardId:          z.string(),
      intervalMinutes: z.number().nullable().describe('Minutes between recurrences, or null to clear'),
      boardId:         z.string(),
    },
  }, ({ cardId, intervalMinutes, boardId }) => wrapWrite(
    'set_card_recur', { cardId, intervalMinutes, boardId },
    () => setCardRecur(cardId, intervalMinutes, boardId),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('set_card_hidden', {
    title: 'Set card hidden',
    description: 'Shows or hides a card.',
    inputSchema: { cardId: z.string(), hidden: z.boolean(), boardId: z.string() },
  }, ({ cardId, hidden, boardId }) => wrapWrite(
    'set_card_hidden', { cardId, hidden, boardId },
    () => setCardHidden(cardId, hidden, boardId),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('move_card', {
    title: 'Move card',
    description: 'Moves a card to a different list and/or position.',
    inputSchema: {
      cardId:      z.string(),
      newListId:   z.string(),
      newPosition: z.number(),
      boardId:     z.string(),
    },
  }, ({ cardId, newListId, newPosition, boardId }) => wrapWrite(
    'move_card', { cardId, newListId, newPosition, boardId },
    () => moveCard(cardId, newListId, newPosition, boardId),
    { entityType: 'card', entityId: cardId },
    [cardId, newListId],
  ))

  server.registerTool('reorder_cards', {
    title: 'Reorder cards',
    description: 'Bulk-updates list membership and position for multiple cards.',
    inputSchema: {
      updates: z.array(z.object({
        id:       z.string(),
        list_id:  z.string(),
        position: z.number(),
      })).describe('Full ordered list of card position updates'),
      boardId: z.string(),
    },
  }, ({ updates, boardId }) => wrapWrite(
    'reorder_cards', { boardId, count: updates.length },
    () => reorderCards(updates, boardId),
    undefined, updates.map(u => u.id),
  ))

  server.registerTool('update_card_position', {
    title: 'Update card position',
    description: 'Sets the canvas X/Y position of a card (free-mode).',
    inputSchema: { cardId: z.string(), x: z.number(), y: z.number() },
  }, ({ cardId, x, y }) => wrapWrite(
    'update_card_position', { cardId, x, y },
    () => updateCardPosition(cardId, x, y),
    { entityType: 'card', entityId: cardId },
  ))

  server.registerTool('create_free_card', {
    title: 'Create free card',
    description: 'Creates a card at a specific canvas position (free-mode).',
    inputSchema: {
      listId:  z.string(),
      title:   z.string(),
      boardId: z.string(),
      x:       z.number(),
      y:       z.number(),
    },
  }, ({ listId, title, boardId, x, y }) => wrapWrite(
    'create_free_card', { listId, title, boardId, x, y },
    () => createFreeCard(listId, title, boardId, x, y),
    undefined, [listId],
  ))

  // ── Elements ────────────────────────────────────────────────────────────────

  server.registerTool('create_element', {
    title: 'Create element',
    description: 'Creates a canvas element (shape, image, drawing, text, portal, textfile, folderlink, claude, pdf).',
    inputSchema: {
      boardId: z.string(),
      type:    ELEMENT_TYPE,
      x:       z.number(),
      y:       z.number(),
      data:    z.record(z.string(), z.unknown()).describe('Element-specific data payload'),
      width:   z.number().optional(),
      height:  z.number().optional(),
    },
  }, ({ boardId, type, x, y, data, width, height }) => wrapWrite(
    'create_element', { boardId, type, x, y, width, height },
    () => createElement(boardId, type, x, y, data, width, height),
    undefined, [boardId],
  ))

  server.registerTool('update_element', {
    title: 'Update element',
    description: 'Updates position, size, data, or deadline of a canvas element.',
    inputSchema: {
      elementId: z.string(),
      x:         z.number().optional(),
      y:         z.number().optional(),
      data:      z.record(z.string(), z.unknown()).optional(),
      width:     z.number().optional(),
      height:    z.number().optional(),
      deadline:  z.string().nullable().optional(),
    },
  }, ({ elementId, ...updates }) => wrapWrite(
    'update_element', { elementId, x: updates.x, y: updates.y, width: updates.width, height: updates.height, deadline: updates.deadline },
    () => updateElement(elementId, updates),
    { entityType: 'element', entityId: elementId },
  ))

  server.registerTool('delete_element', {
    title: 'Delete element',
    description: 'Permanently deletes a canvas element.',
    inputSchema: { elementId: z.string() },
  }, ({ elementId }) => wrapWrite(
    'delete_element', { elementId },
    () => deleteElement(elementId),
    { entityType: 'element', entityId: elementId },
  ))

  server.registerTool('create_text_file', {
    title: 'Create text file',
    description: 'Creates a text file element on a canvas or in a folder board.',
    inputSchema: {
      boardId: z.string(),
      name:    z.string(),
      content: z.string(),
      x:       z.number().optional(),
      y:       z.number().optional(),
    },
  }, ({ boardId, name, content, x, y }) => wrapWrite(
    'create_text_file', { boardId, name, x, y },
    () => createTextFile(boardId, name, content, x, y),
    undefined, [boardId],
  ))

  server.registerTool('create_url_preview', {
    title: 'Create URL preview',
    description: 'Creates a rich link-preview card on a board from a URL (fetches the page image, title and domain). Use this to put a link, product page, listing, or website on a board visually instead of as plain text. boardId is required; x/y are optional canvas coords.',
    inputSchema: {
      boardId: z.string(),
      url:     z.string().describe('The full http/https URL to preview.'),
      x:       z.number().optional(),
      y:       z.number().optional(),
    },
  }, ({ boardId, url, x, y }) => wrapWrite(
    'create_url_preview', { boardId, url, x, y },
    () => createUrlPreview(boardId, url, x, y),
    undefined, [boardId],
  ))

  server.registerTool('update_text_file', {
    title: 'Update text file',
    description: 'Updates the name and content of a text file element.',
    inputSchema: {
      elementId: z.string(),
      name:      z.string(),
      content:   z.string(),
      boardId:   z.string(),
    },
  }, ({ elementId, name, content, boardId }) => wrapWrite(
    'update_text_file', { elementId, name, boardId },
    () => updateTextFile(elementId, name, content, boardId),
    { entityType: 'element', entityId: elementId },
  ))

  server.registerTool('move_element_to_board', {
    title: 'Move element to board',
    description: 'Moves a canvas element to a different board (resets its position to origin).',
    inputSchema: {
      elementId:     z.string(),
      targetBoardId: z.string(),
      fromBoardId:   z.string().optional(),
    },
  }, ({ elementId, targetBoardId, fromBoardId }) => wrapWrite(
    'move_element_to_board', { elementId, targetBoardId, fromBoardId },
    () => moveElementToBoard(elementId, targetBoardId, fromBoardId),
    { entityType: 'element', entityId: elementId },
    [elementId, targetBoardId],
  ))

  server.registerTool('upsert_element', {
    title: 'Upsert element',
    description: 'Insert-or-update a canvas element by ID (used for undo/redo restore).',
    inputSchema: {
      id:      z.string(),
      boardId: z.string(),
      type:    ELEMENT_TYPE,
      x:       z.number(),
      y:       z.number(),
      data:    z.record(z.string(), z.unknown()),
      width:   z.number().nullable().optional(),
      height:  z.number().nullable().optional(),
    },
  }, ({ id, boardId, type, x, y, data, width, height }) => wrapWrite(
    'upsert_element', { id, boardId, type, x, y, width, height },
    () => upsertElement(id, boardId, type, x, y, data, width, height),
    { entityType: 'element', entityId: id },
  ))

  server.registerTool('reorder_folder_items', {
    title: 'Reorder folder items',
    description: 'Bulk-reorders sub-folders and files within a folder board.',
    inputSchema: {
      parentBoardId: z.string(),
      folderIds:     z.array(z.string()).describe('Ordered list of child board IDs'),
      fileIds:       z.array(z.string()).describe('Ordered list of file element IDs'),
    },
  }, ({ parentBoardId, folderIds, fileIds }) => wrapWrite(
    'reorder_folder_items', { parentBoardId, folderCount: folderIds.length, fileCount: fileIds.length },
    () => reorderFolderItems(parentBoardId, folderIds, fileIds),
    undefined, [...folderIds, ...fileIds],
  ))

  // ── Edges ───────────────────────────────────────────────────────────────────

  server.registerTool('create_edge', {
    title: 'Create edge',
    description: 'Creates a connection (edge/link) between two canvas nodes.',
    inputSchema: {
      boardId:      z.string(),
      source:       z.string().describe('Source node ID'),
      target:       z.string().describe('Target node ID'),
      sourceHandle: z.string().optional(),
      targetHandle: z.string().optional(),
    },
  }, ({ boardId, source, target, sourceHandle, targetHandle }) => wrapWrite(
    'create_edge', { boardId, source, target, sourceHandle, targetHandle },
    () => createEdge(boardId, source, target, sourceHandle, targetHandle),
    undefined, [boardId],
  ))

  server.registerTool('delete_edge', {
    title: 'Delete edge',
    description: 'Deletes a canvas edge/connection.',
    inputSchema: { edgeId: z.string() },
  }, ({ edgeId }) => wrapWrite(
    'delete_edge', { edgeId },
    () => deleteEdge(edgeId),
    { entityType: 'edge', entityId: edgeId },
  ))

  server.registerTool('update_edge_shape', {
    title: 'Update edge shape',
    description: 'Updates the shape data of an edge (e.g. bend control point).',
    inputSchema: {
      edgeId: z.string(),
      data:   z.record(z.string(), z.unknown()).describe('Edge shape data, e.g. { cx, cy } for quadratic bend'),
    },
  }, ({ edgeId, data }) => wrapWrite(
    'update_edge_shape', { edgeId },
    () => updateEdgeShape(edgeId, data),
    { entityType: 'edge', entityId: edgeId },
  ))

  server.registerTool('upsert_edge', {
    title: 'Upsert edge',
    description: 'Insert-or-update an edge by ID (used for undo/redo restore).',
    inputSchema: {
      id:           z.string(),
      boardId:      z.string(),
      source:       z.string(),
      target:       z.string(),
      sourceHandle: z.string().nullable().optional(),
      targetHandle: z.string().nullable().optional(),
    },
  }, ({ id, boardId, source, target, sourceHandle, targetHandle }) => wrapWrite(
    'upsert_edge', { id, boardId, source, target, sourceHandle, targetHandle },
    () => upsertEdge(id, boardId, source, target, sourceHandle, targetHandle),
    { entityType: 'edge', entityId: id },
  ))

  // ── PDFs (read-only) ────────────────────────────────────────────────────────

  server.registerTool('get_pdf_url', {
    title: 'Get PDF URL',
    description: 'Mints a 1-hour signed URL for a stored PDF.',
    inputSchema: { path: z.string().describe('Storage path of the PDF (from element data.storagePath)') },
  }, ({ path }) => wrap(() => getPdfUrl(path)))

  // ── Devices ─────────────────────────────────────────────────────────────────

  server.registerTool('create_device_link', {
    title: 'Create device link',
    description: 'Creates a pending iOS device pairing link. Returns the 6-character pairing code.',
    inputSchema: { name: z.string().optional().describe('Device name (default: "iOS device")') },
  }, ({ name }) => wrapWrite(
    'create_device_link', { name },
    () => createDeviceLink(name),
  ))

  server.registerTool('remove_device_link', {
    title: 'Remove device link',
    description: 'Removes a paired or unpaired device link.',
    inputSchema: { id: z.string().describe('Device link ID') },
  }, ({ id }) => wrapWrite(
    'remove_device_link', { id },
    () => removeDeviceLink(id),
    undefined, [id],
  ))

  // ── User settings ───────────────────────────────────────────────────────────

  server.registerTool('save_anthropic_key', {
    title: 'Save Anthropic key',
    description: 'Encrypts and saves the user\'s Anthropic API key.',
    inputSchema: { key: z.string().describe('Anthropic API key (must start with sk-ant-)') },
  }, ({ key }) => wrapWrite(
    'save_anthropic_key', {},
    () => saveAnthropicKey(key),
  ))

  server.registerTool('remove_anthropic_key', {
    title: 'Remove Anthropic key',
    description: 'Removes the stored Anthropic API key.',
    inputSchema: undefined,
  }, () => wrapWrite(
    'remove_anthropic_key', {},
    () => removeAnthropicKey(),
  ))

  server.registerTool('set_claude_auto_apply', {
    title: 'Set Claude auto-apply',
    description: 'Toggles whether Claude is allowed to make write changes (true = writes enabled).',
    inputSchema: { enabled: z.boolean() },
  }, ({ enabled }) => wrapWrite(
    'set_claude_auto_apply', { enabled },
    () => setClaudeAutoApply(enabled),
  ))

  server.registerTool('get_claude_status', {
    title: 'Get Claude status',
    description: 'Returns whether an Anthropic key is stored and whether auto-apply is on.',
    inputSchema: undefined,
  }, () => wrap(() => getClaudeStatus()))

  server.registerTool('set_stocks_enabled', {
    title: 'Set stocks enabled',
    description: 'Enables or disables the Stock Viewer feature for the user.',
    inputSchema: { enabled: z.boolean() },
  }, ({ enabled }) => wrapWrite(
    'set_stocks_enabled', { enabled },
    () => setStocksEnabled(enabled),
  ))

  server.registerTool('get_stocks_enabled', {
    title: 'Get stocks enabled',
    description: 'Returns whether the Stock Viewer feature is enabled for the user.',
    inputSchema: undefined,
  }, () => wrap(() => getStocksEnabled()))

  // ── Account links ───────────────────────────────────────────────────────────

  server.registerTool('link_account', {
    title: 'Link account',
    description: 'Links another user account to the current user as a member.',
    inputSchema: {
      memberId: z.string().describe('User ID of the account to link'),
      label:    z.string().describe('Display label for the linked account'),
    },
  }, ({ memberId, label }) => wrapWrite(
    'link_account', { memberId, label },
    () => linkAccount(memberId, label),
    undefined, [memberId],
  ))

  server.registerTool('accept_link', {
    title: 'Accept account link',
    description: 'Accepts a pending account link invitation.',
    inputSchema: { linkId: z.string().describe('Account link ID to accept') },
  }, ({ linkId }) => wrapWrite(
    'accept_link', { linkId },
    () => acceptLink(linkId),
    undefined, [linkId],
  ))

  server.registerTool('remove_link', {
    title: 'Remove account link',
    description: 'Removes an account link (either as owner or member).',
    inputSchema: { linkId: z.string().describe('Account link ID to remove') },
  }, ({ linkId }) => wrapWrite(
    'remove_link', { linkId },
    () => removeLink(linkId),
    undefined, [linkId],
  ))

  // ── Library tools (read-only, admin-scoped via service role) ─────────────────

  const adminSupabase = createAdminClient()

  server.registerTool('list_library_groups', {
    title: 'List library groups',
    description: 'List the available groups and categories in the personal legal and research library, with item counts. Always call this first before searching — it tells you which area to filter by and how many items exist in each group.',
    inputSchema: {
      type: z.enum(['legal_case', 'paper']).optional().describe('Optional: filter to one item type'),
    },
  }, async ({ type: itemType }) => {
    if (!adminUserId) return fail('Library not configured (ADMIN_EMAIL missing or user not found)')
    let query = adminSupabase
      .from('library_items')
      .select('type, metadata')
      .eq('user_id', adminUserId)
      .eq('deleted', false)
    if (itemType) query = query.eq('type', itemType)
    const { data, error } = await query
    if (error) return fail(error.message)
    const counts = new Map<string, number>()
    for (const row of data ?? []) {
      const meta = row.metadata as Record<string, unknown> | null
      const areas: string[] = Array.isArray(meta?.rattsomrade) ? (meta!.rattsomrade as unknown[]).map(String) : []
      for (const area of areas.length ? areas : ['(uncategorized)']) {
        const k = `${row.type}\t${area}`
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
    const groups = Array.from(counts.entries())
      .map(([k, count]) => { const [type, group] = k.split('\t'); return { type, group, count } })
      .sort((a, b) => b.count - a.count)
    return ok(groups)
  })

  server.registerTool('search_library', {
    title: 'Search library',
    description: 'Search the personal legal case and research paper library. Returns compact results — title, summary, key metadata — WITHOUT full text. Use this to identify 1-2 relevant items, then call get_library_item for the full text of finalists only. Never call get_library_item on more than 2 items per query.',
    inputSchema: {
      query: z.string().optional().describe('Full-text search — keywords, legal concepts, statute citations'),
      type: z.enum(['legal_case', 'paper']).optional().describe('Optional: filter to one item type'),
      tags: z.array(z.string()).optional().describe('Optional: filter by tags (rättsområde, principer, or custom)'),
      limit: z.number().optional().describe('Max results to return (default 8, max 20)'),
    },
  }, async ({ query, type: itemType, tags, limit: rawLimit }) => {
    if (!adminUserId) return fail('Library not configured (ADMIN_EMAIL missing or user not found)')
    const limit = Math.min(20, Math.max(1, rawLimit ?? 8))
    let q = adminSupabase
      .from('library_items')
      .select('id, type, title, summary, tags, source_url, metadata, updated_at, verified')
      .eq('user_id', adminUserId)
      .eq('deleted', false)
    if (itemType) q = q.eq('type', itemType)
    if (tags?.length) q = q.contains('tags', tags)
    if (query) q = q.textSearch('tsv', query, { config: 'swedish', type: 'websearch' })
    q = q.order('updated_at', { ascending: false }).limit(limit)
    const { data, error } = await q
    if (error) return fail(error.message)
    return ok(data ?? [])
  })

  server.registerTool('get_library_item', {
    title: 'Get library item',
    description: 'Get the complete record for one library item, including the full case or paper text. This is expensive — only call it for 1-2 finalist items after using search_library to narrow down candidates. Never use this to browse or discover.',
    inputSchema: {
      id: z.string().describe('The item ID from search_library results'),
    },
  }, async ({ id }) => {
    if (!adminUserId) return fail('Library not configured (ADMIN_EMAIL missing or user not found)')
    const { data, error } = await adminSupabase
      .from('library_items')
      .select('*')
      .eq('id', id)
      .eq('user_id', adminUserId)
      .maybeSingle()
    if (error) return fail(error.message)
    if (!data) return fail('Item not found')
    return ok(data)
  })

  // ── Research satellite tools (i.syncedsys, over HTTP via researchFetch) ───────
  // These drive the two-phase research workflow against the i.syncedsys API:
  //   Phase 2 (enrich):  research_list_domains → research_search(phase2_status=pending)
  //                      → reason about each record → research_enrich_record
  //   Phase 3 (connect): research_upsert_concept → research_search(not_concept_id=<id>)
  //                      → reason about relevance → research_connect_record (per record)
  //                      → research_record_concept_run (once, at the end)

  server.registerTool('research_list_domains', {
    title: 'List research domains',
    description: 'List every research domain with its display_name, record_count, enrichment_context, structural_tag_categories, and last_*_at timestamps. ALWAYS call this first when enriching (Phase 2): a domain\'s enrichment_context and structural_tag_categories are the classification guidance you must read before assigning structural tags to any record in it.',
    inputSchema: undefined,
  }, () => wrap(() => researchFetch('/api/research/domains')))

  server.registerTool('research_search', {
    title: 'Search research records',
    description: 'Search records within one domain. Returns compact records (not full text). In Phase 2 pass phase2_status="pending" to find records that still need structural tags. In Phase 3 pass not_concept_id=<concept id> to find records not yet checked against a concept. Combine with q, structural_tag, derived_tag, concept_id, date_from/date_to, and limit/offset as needed.',
    inputSchema: {
      domain: z.string().describe('Domain slug from research_list_domains (e.g. "legal_cases")'),
      q: z.string().optional().describe('Full-text search query'),
      structural_tag: z.string().optional().describe('Only records carrying this structural tag'),
      derived_tag: z.string().optional().describe('Only records carrying this derived tag'),
      concept_id: z.string().optional().describe('Only records already connected to this concept'),
      not_concept_id: z.string().optional().describe('Only records NOT yet checked against this concept — use in Phase 3 to find remaining work'),
      phase2_status: z.string().optional().describe('Enrichment status filter — pass "pending" to find records not yet enriched (Phase 2)'),
      date_from: z.string().optional().describe('ISO date lower bound (inclusive)'),
      date_to: z.string().optional().describe('ISO date upper bound (inclusive)'),
      limit: z.number().int().optional().describe('Max records to return'),
      offset: z.number().int().optional().describe('Pagination offset'),
    },
  }, ({ domain, ...query }) => wrap(() => researchFetch(`/api/research/${encodeURIComponent(domain)}`, { query })))

  server.registerTool('research_get_record', {
    title: 'Get research record',
    description: 'Get the complete record — including its full text — for one record in a domain. Use after research_search has narrowed down which record you need to reason about (in Phase 2 to enrich, or Phase 3 to judge relevance).',
    inputSchema: {
      domain: z.string().describe('Domain slug'),
      id: z.string().describe('Record ID from research_search results'),
    },
  }, ({ domain, id }) => wrap(() => researchFetch(`/api/research/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`)))

  server.registerTool('research_list_concepts', {
    title: 'List research concepts',
    description: 'List existing concepts — the cross-cutting ideas that records get connected to in Phase 3. Optionally filter by q (name search) or domain. Use this to find an existing concept id before creating a new one with research_upsert_concept.',
    inputSchema: {
      q: z.string().optional().describe('Search concept names'),
      domain: z.string().optional().describe('Filter to concepts used in this domain'),
    },
  }, ({ q, domain }) => wrap(() => researchFetch('/api/research/concepts', { query: { q, domain } })))

  server.registerTool('research_enrich_record', {
    title: 'Enrich research record (Phase 2)',
    description: 'Assign structural tags to one record during Phase 2, AFTER reasoning about its content against the domain\'s enrichment_context and structural_tag_categories (from research_list_domains). Each tag names the category it belongs to and a 0–1 confidence.',
    inputSchema: {
      domain: z.string().describe('Domain slug'),
      id: z.string().describe('Record ID to tag'),
      structural_tags: z.array(z.object({
        tag: z.string().describe('The tag value'),
        category: z.string().describe('Which of the domain\'s structural_tag_categories this tag belongs to'),
        confidence: z.number().min(0).max(1).describe('0–1 confidence that this tag applies'),
      })).describe('The structural tags to assign to this record'),
    },
  }, ({ domain, id, structural_tags }) => wrap(() => researchFetch(
    `/api/research/${encodeURIComponent(domain)}/${encodeURIComponent(id)}/enrich`,
    { body: { structural_tags } },
  )))

  server.registerTool('research_connect_record', {
    title: 'Connect research record to a concept (Phase 3)',
    description: 'Record a Phase 3 relevance judgment: whether one record relates to one concept, with your reasoning. Set relevant=false to record a checked-but-not-relevant result — this still marks the record as checked so a later research_search with not_concept_id skips it. Cite the supporting passage when relevant=true.',
    inputSchema: {
      domain: z.string().describe('Domain slug'),
      id: z.string().describe('Record ID being judged'),
      concept_id: z.string().describe('Concept ID (from research_upsert_concept)'),
      concept_name: z.string().describe('Concept name'),
      relevant: z.boolean().describe('Whether this record is relevant to the concept'),
      confidence: z.number().min(0).max(1).describe('0–1 confidence in the judgment'),
      reasoning: z.string().describe('Why the record is or is not relevant to the concept'),
      specific_passage: z.string().optional().describe('The exact passage from the record that supports a relevant=true judgment'),
    },
  }, ({ domain, id, ...body }) => wrap(() => researchFetch(
    `/api/research/${encodeURIComponent(domain)}/${encodeURIComponent(id)}/connect`,
    { body },
  )))

  server.registerTool('research_upsert_concept', {
    title: 'Create or fetch a research concept',
    description: 'Create a concept (or fetch the existing one with the same name) and return it including its id. Call this first in Phase 3 to get the concept_id you then pass to research_search (not_concept_id), research_connect_record, and research_record_concept_run.',
    inputSchema: {
      name: z.string().describe('Concept name'),
      description: z.string().optional().describe('What the concept means — the definition used to judge record relevance'),
    },
  }, ({ name, description }) => wrap(() => researchFetch('/api/research/concepts', { body: { name, description } })))

  server.registerTool('research_record_concept_run', {
    title: 'Record a Phase 3 concept run',
    description: 'Call once at the END of a Phase 3 pass over a domain, after every record has been connected/checked for this concept. Records that the concept was run against this domain (updates its last-run bookkeeping).',
    inputSchema: {
      id: z.string().describe('Concept ID'),
      domain: z.string().describe('Domain the Phase 3 pass covered'),
    },
  }, ({ id, domain }) => wrap(() => researchFetch(
    `/api/research/concepts/${encodeURIComponent(id)}/record-run`,
    { body: { domain } },
  )))

  // Tradera — live listing search on the Swedish marketplace. Proxied through the
  // i.syncedsys satellite (same bearer + base URL as research) which holds the
  // Tradera API credentials and speaks SOAP. Every result carries its own
  // tradera.com url so the assistant can hand listing links straight back.
  server.registerTool('tradera_search', {
    title: 'Search Tradera listings',
    description: 'Search live listings on Tradera (the Swedish marketplace/auction site). Returns matching listings, each with a real tradera.com url plus current/buy-now price, next bid, bid count, end date, seller and thumbnail. Use this to find items for the user and give them the listing urls.',
    inputSchema: {
      q: z.string().describe('Search words, e.g. "iphone 13" or "rolex submariner"'),
      categoryId: z.number().optional().describe('Tradera category id to restrict to (omit for all categories)'),
      priceMin: z.number().optional().describe('Minimum price in SEK'),
      priceMax: z.number().optional().describe('Maximum price in SEK'),
      orderBy: z.string().optional().describe('Sort order: "Relevance", "PriceAscending", "PriceDescending", "EndDateAscending", "EndDateDescending"'),
      itemType: z.string().optional().describe('"All", "Auction", or "BuyItNow"'),
      itemStatus: z.string().optional().describe('"Active" (default) or "Ended"'),
      itemCondition: z.string().optional().describe('"All", "OnlyNew", or "OnlySecondHand"'),
      onlyAuctionsWithBuyNow: z.boolean().optional().describe('Only auctions that also offer a buy-now price'),
      searchInDescription: z.boolean().optional().describe('Also match words in the description, not just the title'),
      perPage: z.number().optional().describe('Results per page, 1–50 (default 25)'),
      page: z.number().optional().describe('Page number, starting at 1'),
    },
  }, ({ q, ...rest }) => wrap(() => researchFetch('/api/tradera/search', { query: { q, ...rest } })))

  server.registerTool('tradera_get_item', {
    title: 'Get a Tradera listing',
    description: 'Fetch full detail for one Tradera listing by its numeric item id (taken from a tradera_search result). Returns the listing\'s title, description, current/buy-now price, bids, end date, images and a tradera.com url.',
    inputSchema: {
      id: z.number().describe('Tradera item id from a tradera_search result'),
    },
  }, ({ id }) => wrap(() => researchFetch(`/api/tradera/item/${encodeURIComponent(String(id))}`)))

  const PHOTO_SELECT = 'id, filename, r2_key, mime_type, size_bytes, created_at, expires_at, is_saved, project_tag, description, width, height'

  server.registerTool('get_workspace_photos', {
    title: 'Get workspace photos',
    description: 'Returns workspace photos uploaded from the user\'s iOS companion app. Each photo has a number (1 = newest), a signed URL to view the image, and a description field. Reference photos by number when the user says "first image", "second image", etc. Use this before update_workspace_photo so you have the correct ID.',
    inputSchema: {
      limit: z.number().min(1).max(50).optional().describe('Maximum number of photos to return (default 20, max 50)'),
      project_tag: z.string().optional().describe('Filter by project tag'),
      saved_only: z.boolean().optional().describe('Return only saved/permanent photos'),
    },
  }, async ({ limit = 20, project_tag, saved_only }) => {
    let query = adminSupabase
      .from('workspace_photos')
      .select(PHOTO_SELECT)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 50))

    if (saved_only) query = query.eq('is_saved', true)
    if (project_tag) query = query.eq('project_tag', project_tag)

    const { data, error } = await query
    if (error) return fail(error.message)

    const r2 = getR2Client()
    const photos = await Promise.all(
      (data ?? []).map(async (photo, i) => {
        const signed_url = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: R2_BUCKET, Key: photo.r2_key }),
          { expiresIn: 3600 },
        ).catch(() => '')
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { r2_key: _key, ...rest } = photo
        return { ...rest, number: i + 1, signed_url }
      }),
    )

    return ok(photos)
  })

  server.registerTool('update_workspace_photo', {
    title: 'Update workspace photo',
    description: 'Update a workspace photo\'s description or exemption from deletion. Identify the photo by its number (1 = newest) or its UUID. Call get_workspace_photos first to get IDs and numbers. Use this to: add/update a description so the photo is easier to reference later; set is_saved=true to exempt it from auto-deletion.',
    inputSchema: {
      id: z.string().optional().describe('Photo UUID (from get_workspace_photos)'),
      number: z.number().int().min(1).optional().describe('Photo number — 1 is the newest photo'),
      description: z.string().optional().describe('New description for the photo (set to empty string to clear)'),
      is_saved: z.boolean().optional().describe('true = exempt from auto-deletion; false = restore 7-day expiry'),
    },
  }, async ({ id, number, description, is_saved }) => {
    if (!id && !number) return fail('Provide either id or number')

    let photoId = id
    if (!photoId && number != null) {
      const { data, error } = await adminSupabase
        .from('workspace_photos')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(number - 1, number - 1)
        .single()
      if (error || !data) return fail(`No photo found at position ${number}`)
      photoId = data.id
    }

    const patch: Record<string, unknown> = {}
    if (typeof description === 'string') patch.description = description.trim() || null
    if (typeof is_saved === 'boolean') {
      patch.is_saved = is_saved
      patch.expires_at = is_saved ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }
    if (Object.keys(patch).length === 0) return fail('No fields to update')

    const { data, error } = await adminSupabase
      .from('workspace_photos')
      .update(patch)
      .eq('id', photoId!)
      .eq('user_id', userId)
      .select(PHOTO_SELECT)
      .single()

    if (error || !data) return fail('Photo not found or update failed')
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { r2_key: _key, ...rest } = data
    return ok(rest)
  })

  server.registerTool('get_photo_image', {
    title: 'View photo image',
    description: 'Fetch a workspace photo as an inline image so you can directly view its contents. Use this instead of fetching the signed URL separately. Identify by number (1 = newest) or UUID. Call get_workspace_photos first to see what is available.',
    inputSchema: {
      id: z.string().optional().describe('Photo UUID'),
      number: z.number().int().min(1).optional().describe('Photo number — 1 is the newest'),
    },
  }, async ({ id, number }) => {
    if (!id && !number) return fail('Provide either id or number')

    type PhotoRow = { id: string; r2_key: string; mime_type: string; filename: string; description: string | null }
    let row: PhotoRow | null = null

    if (number != null && !id) {
      const { data, error } = await adminSupabase
        .from('workspace_photos')
        .select('id, r2_key, mime_type, filename, description')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(number - 1, number - 1)
        .single()
      if (error || !data) return fail(`No photo found at position ${number}`)
      row = data as PhotoRow
    } else {
      const { data, error } = await adminSupabase
        .from('workspace_photos')
        .select('id, r2_key, mime_type, filename, description')
        .eq('id', id!)
        .eq('user_id', userId)
        .single()
      if (error || !data) return fail('Photo not found')
      row = data as PhotoRow
    }

    if (row.mime_type === 'image/heic') {
      return fail('HEIC images cannot be displayed inline. Use the signed URL from get_workspace_photos to view this photo.')
    }

    let imageData: string
    try {
      const r2Res = await getR2Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key }))
      const chunks: Uint8Array[] = []
      for await (const chunk of r2Res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      imageData = Buffer.concat(chunks).toString('base64')
    } catch {
      return fail('Failed to fetch image from storage')
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            id: row.id,
            number,
            filename: row.filename,
            description: row.description,
            mime_type: row.mime_type,
          }, null, 2),
        },
        {
          type: 'image' as const,
          data: imageData,
          mimeType: row.mime_type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
        },
      ],
    }
  })

  server.registerTool('get_photo_settings', {
    title: 'Get photo library settings',
    description: 'Returns the current photo library settings, including whether auto-deletion is paused.',
    inputSchema: undefined,
  }, async () => {
    const { data } = await adminSupabase
      .from('photo_library_settings')
      .select('pause_deletion')
      .eq('user_id', userId)
      .maybeSingle()
    return ok({ pause_deletion: data?.pause_deletion ?? false })
  })

  server.registerTool('set_photo_settings', {
    title: 'Update photo library settings',
    description: 'Update photo library settings. Set pause_deletion=true to pause all automatic photo deletion indefinitely; false to resume it.',
    inputSchema: {
      pause_deletion: z.boolean().describe('true = pause all auto-deletion; false = resume normal 7-day expiry'),
    },
  }, async ({ pause_deletion }) => {
    const { error } = await adminSupabase
      .from('photo_library_settings')
      .upsert({ user_id: userId, pause_deletion, updated_at: new Date().toISOString() })
    if (error) return fail(error.message)
    return ok({ pause_deletion })
  })

  return server
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function handle(req: NextRequest): Promise<Response> {
  const [auth, adminUserId] = await Promise.all([resolveMcpAuth(req), getAdminUserId()])
  if (!auth.ok) {
    // Point clients at the www host directly — the bare apex 308-redirects, and
    // the resource metadata + OAuth exchange must avoid a redirect the client
    // won't follow with its request body.
    let host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'www.syncedsys.com'
    if (host === 'syncedsys.com') host = 'www.syncedsys.com'
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    const base = `${proto}://${host}`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (auth.status === 401) {
      // Point MCP clients (Claude.ai) at the Protected Resource Metadata.
      // RFC 9728 §5.1: the param is exactly `resource_metadata` (NOT
      // `resource_metadata_url`) and the URL must be a quoted-string. The
      // canonical location is well-known path-insertion: the segment goes
      // between host and the resource's path (/api/mcp).
      headers['WWW-Authenticate'] =
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`
    }
    return new Response(JSON.stringify({ error: auth.error }), { status: auth.status, headers })
  }

  // Run the entire MCP exchange inside the auth context so every server action's
  // createClient() is scoped to this user and RLS applies — no per-action change.
  return supabaseAuthContext.run({ accessToken: auth.accessToken }, async () => {
    const supabase = await createClient()
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = buildServer(supabase, auth.userId, adminUserId)
    await server.connect(transport)
    return transport.handleRequest(req)
  })
}

export const GET    = handle
export const POST   = handle
export const DELETE = handle
