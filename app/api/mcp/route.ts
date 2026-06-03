import { NextRequest } from 'next/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { decryptSecret } from '@/lib/crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createBoard, createGroup, moveTab, updateBoardFreePosition, updateBoardContent,
  createSubTab, deleteBoard, renameBoard, updateBoard, layoutBoardGrid, setBoardSynced,
  moveBoardToParent, copyBoardInto, ensureMirrorPortal,
  createList, deleteList, renameList, setListWidget, setListDeadline, setListHidden, updateListPosition,
  createCard, deleteCard, updateCard, updateCardDone, setCardDeadline, setCardRecur, setCardHidden,
  moveCard, reorderCards, updateCardPosition, createFreeCard,
  createElement, updateElement, deleteElement, createTextFile, updateTextFile,
  moveElementToBoard, upsertElement, reorderFolderItems,
  createEdge, deleteEdge, updateEdgeShape, upsertEdge,
  getPdfUrl,
  createDeviceLink, removeDeviceLink,
  saveAnthropicKey, removeAnthropicKey, setClaudeAutoApply, getClaudeStatus,
  setStocksEnabled, getStocksEnabled,
} from '@/app/actions'

export const dynamic = 'force-dynamic'

// ── Shared types & helpers ────────────────────────────────────────────────────

type BoardMeta = { id: string; name: string; mode: string; meta: string | null }

const ELEMENT_TYPE = z.enum(['shape', 'image', 'drawing', 'text', 'portal', 'textfile', 'folderlink', 'claude', 'pdf'])
const BOARD_MODE   = z.enum(['classic', 'trello', 'text', 'folder', 'spreadsheet'])

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

async function fetchBoards(origin: string, cookie: string): Promise<BoardMeta[] | null> {
  const res = await fetch(`${origin}/api/boards/meta`, { headers: { cookie } })
  if (!res.ok) return null
  return res.json()
}

export async function loadApiKey(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('user_secrets').select('anthropic_key_encrypted').eq('user_id', userId).maybeSingle()
  if (!data?.anthropic_key_encrypted) return null
  try { return decryptSecret(data.anthropic_key_encrypted) } catch { return null }
}

export async function suggestBoardMeta(name: string, mode: string, apiKey: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `Write a 1-2 sentence description for a board named "${name}" (mode: ${mode}). The description helps an AI assistant understand what this board is for. Be specific and concise. Reply with only the description, no quotes.`,
    }],
  })
  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
  return text.slice(0, 150)
}

// ── MCP server builder ────────────────────────────────────────────────────────

function buildServer(cookie: string, origin: string, supabase: SupabaseClient, userId: string) {
  const server = new McpServer({ name: 'syncedsys', version: '1.0.0' })

  // ── AI / context tools ──────────────────────────────────────────────────────

  server.registerTool('get_boards_context', {
    title: 'Get boards context',
    description: 'Returns all boards for the authenticated user with name, mode, and AI description.',
    inputSchema: undefined,
  }, async () => {
    const boards = await fetchBoards(origin, cookie)
    if (!boards) return fail('Failed to fetch boards.')
    return ok(formatBoards(boards))
  })

  server.registerTool('find_relevant_boards', {
    title: 'Find relevant boards',
    description: 'Returns the 1–3 most relevant boards for a query, matched against name and description.',
    inputSchema: { query: z.string().describe('What the user is looking for') },
  }, async ({ query }) => {
    const [boards, apiKey] = await Promise.all([fetchBoards(origin, cookie), loadApiKey(supabase, userId)])
    if (!boards) return fail('Failed to fetch boards.')
    if (!apiKey)  return fail('No Anthropic API key. Add one in Settings.')
    if (!boards.length) return ok([])
    const list = boards.map(b => `${b.id}\t${b.name}\t${b.meta ?? ''}`).join('\n')
    const response = await new Anthropic({ apiKey }).messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 256,
      messages: [{ role: 'user', content: `Pick the 1-3 most relevant board IDs for: "${query}"\n\nBoards (id\\tname\\tdesc):\n${list}\n\nReply ONLY with a JSON array of IDs, e.g. ["id1"]. No explanation.` }],
    })
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
      supabase.from('board_elements').select('id,type,data,deadline').eq('board_id', board_id),
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
    if ((board.mode === 'text' || board.mode === 'spreadsheet') && board.content?.trim()) {
      lines.push('\n## Content'); lines.push(board.content.slice(0, 3000))
    }
    const els = elementsResult.data ?? []
    if (els.length) {
      lines.push('\n## Canvas elements')
      for (const e of els) {
        const d = e.data ?? {}
        let label = e.type
        if (e.type === 'text')       label = `text: ${String(d.text ?? '').slice(0, 200)}`
        else if (e.type === 'shape') label = `shape(${d.shape ?? 'rect'})${d.label ? ` "${d.label}"` : ''}`
        else if (e.type === 'textfile') label = `file "${d.name ?? 'untitled'}"`
        else if (e.type === 'pdf')   label = `pdf "${d.name ?? 'document'}" (${d.pageCount ?? '?'} pages)${String(d.text ?? '').trim() ? ': ' + String(d.text).slice(0, 2000) : ''}`
        else if (e.type === 'portal') label = d.viewerKind ? `viewer-portal (${d.viewerKind})` : `portal → ${d.targetBoardId ?? '(unset)'}`
        else if (e.type === 'folderlink') label = `folder-link "${d.name ?? ''}" → ${d.targetBoardId ?? '?'}`
        lines.push(`  [${e.id}] ${label}${e.deadline ? ` [due ${e.deadline.slice(0,10)}]` : ''}`)
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
    const apiKey = await loadApiKey(supabase, userId)
    if (!apiKey) return fail('No Anthropic API key. Add one in Settings.')
    return ok(await suggestBoardMeta(name, mode, apiKey))
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
  }, ({ name, color, mode }) => wrap(() => createBoard(name, color, mode)))

  server.registerTool('create_group', {
    title: 'Create group',
    description: 'Creates a group container in the tab bar.',
    inputSchema: {
      name:          z.string(),
      color:         z.string(),
      mode:          z.enum(['folder', 'classic']),
      parentGroupId: z.string().nullable().optional().describe('Parent group ID, or null for top-level'),
    },
  }, ({ name, color, mode, parentGroupId }) => wrap(() => createGroup(name, color, mode, parentGroupId ?? null)))

  server.registerTool('move_tab', {
    title: 'Move tab',
    description: 'Moves a tab into a group and/or reorders it.',
    inputSchema: {
      boardId:      z.string(),
      newGroupId:   z.string().nullable().describe('Target group ID, or null for top-level'),
      beforeBoardId: z.string().nullable().describe('Insert before this board ID, or null for end'),
    },
  }, ({ boardId, newGroupId, beforeBoardId }) => wrap(() => moveTab(boardId, newGroupId, beforeBoardId)))

  server.registerTool('update_board_free_position', {
    title: 'Update board free position',
    description: 'Sets the canvas position of a board in free (group-folder) mode.',
    inputSchema: { boardId: z.string(), x: z.number(), y: z.number() },
  }, ({ boardId, x, y }) => wrap(() => updateBoardFreePosition(boardId, x, y)))

  server.registerTool('update_board_content', {
    title: 'Update board content',
    description: 'Overwrites the text/spreadsheet content of a board.',
    inputSchema: { boardId: z.string(), content: z.string() },
  }, ({ boardId, content }) => wrap(() => updateBoardContent(boardId, content)))

  server.registerTool('create_sub_tab', {
    title: 'Create sub-tab',
    description: 'Creates a child board under a parent board.',
    inputSchema: {
      parentBoardId: z.string(),
      name:  z.string(),
      color: z.string(),
      mode:  BOARD_MODE.optional(),
    },
  }, ({ parentBoardId, name, color, mode }) => wrap(() => createSubTab(parentBoardId, name, color, mode)))

  server.registerTool('delete_board', {
    title: 'Delete board',
    description: 'Permanently deletes a board and all its contents.',
    inputSchema: { boardId: z.string() },
  }, ({ boardId }) => wrap(() => deleteBoard(boardId)))

  server.registerTool('rename_board', {
    title: 'Rename board',
    description: 'Renames a board.',
    inputSchema: { boardId: z.string(), name: z.string() },
  }, ({ boardId, name }) => wrap(() => renameBoard(boardId, name)))

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
  }, ({ boardId, ...updates }) => wrap(() => updateBoard(boardId, updates)))

  server.registerTool('layout_board_grid', {
    title: 'Layout board grid',
    description: 'Spreads a board\'s lists/cards into a kanban grid (use after switching Trello → Classic).',
    inputSchema: { boardId: z.string() },
  }, ({ boardId }) => wrap(() => layoutBoardGrid(boardId)))

  server.registerTool('set_board_synced', {
    title: 'Set board synced',
    description: 'Toggles whether a board is included in iOS sync (true = included).',
    inputSchema: { boardId: z.string(), synced: z.boolean() },
  }, ({ boardId, synced }) => wrap(() => setBoardSynced(boardId, synced)))

  server.registerTool('move_board_to_parent', {
    title: 'Move board to parent',
    description: 'Re-parents a board under another board, or to top-level when newParentId is null.',
    inputSchema: {
      boardId:      z.string(),
      newParentId:  z.string().nullable().describe('Target parent board ID, or null for top-level'),
      fromParentId: z.string().optional().describe('Current parent board ID (for cache revalidation)'),
    },
  }, ({ boardId, newParentId, fromParentId }) => wrap(() => moveBoardToParent(boardId, newParentId, fromParentId)))

  server.registerTool('copy_board_into', {
    title: 'Copy board into',
    description: 'Deep-copies a board subtree (board + lists/cards/elements/edges + descendants) under a destination parent.',
    inputSchema: {
      sourceBoardId:     z.string(),
      destParentBoardId: z.string(),
      freeX: z.number().optional().describe('Canvas X position (default 100)'),
      freeY: z.number().optional().describe('Canvas Y position (default 100)'),
    },
  }, ({ sourceBoardId, destParentBoardId, freeX, freeY }) => wrap(() => copyBoardInto(sourceBoardId, destParentBoardId, freeX, freeY)))

  server.registerTool('ensure_mirror_portal', {
    title: 'Ensure mirror portal',
    description: 'Ensures the target board has a portal pointing back to the source board.',
    inputSchema: { targetBoardId: z.string(), backBoardId: z.string() },
  }, ({ targetBoardId, backBoardId }) => wrap(() => ensureMirrorPortal(targetBoardId, backBoardId)))

  // ── Lists ───────────────────────────────────────────────────────────────────

  server.registerTool('create_list', {
    title: 'Create list',
    description: 'Creates a new list in a board.',
    inputSchema: {
      boardId: z.string(),
      name:    z.string(),
      id:      z.string().optional().describe('Optional explicit UUID'),
    },
  }, ({ boardId, name, id }) => wrap(() => createList(boardId, name, id)))

  server.registerTool('delete_list', {
    title: 'Delete list',
    description: 'Deletes a list and all its cards.',
    inputSchema: { listId: z.string(), boardId: z.string() },
  }, ({ listId, boardId }) => wrap(() => deleteList(listId, boardId)))

  server.registerTool('rename_list', {
    title: 'Rename list',
    description: 'Renames a list.',
    inputSchema: { listId: z.string(), name: z.string(), boardId: z.string() },
  }, ({ listId, name, boardId }) => wrap(() => renameList(listId, name, boardId)))

  server.registerTool('set_list_widget', {
    title: 'Set list widget',
    description: 'Toggles whether a list is displayed as a widget.',
    inputSchema: { listId: z.string(), isWidget: z.boolean(), boardId: z.string() },
  }, ({ listId, isWidget, boardId }) => wrap(() => setListWidget(listId, isWidget, boardId)))

  server.registerTool('set_list_deadline', {
    title: 'Set list deadline',
    description: 'Sets or clears the deadline on a list.',
    inputSchema: {
      listId:   z.string(),
      deadline: z.string().nullable().describe('ISO date string or null to clear'),
      boardId:  z.string(),
    },
  }, ({ listId, deadline, boardId }) => wrap(() => setListDeadline(listId, deadline, boardId)))

  server.registerTool('set_list_hidden', {
    title: 'Set list hidden',
    description: 'Shows or hides a list.',
    inputSchema: { listId: z.string(), hidden: z.boolean(), boardId: z.string() },
  }, ({ listId, hidden, boardId }) => wrap(() => setListHidden(listId, hidden, boardId)))

  server.registerTool('update_list_position', {
    title: 'Update list position',
    description: 'Sets the canvas X/Y position of a list (free-mode).',
    inputSchema: { listId: z.string(), x: z.number(), y: z.number() },
  }, ({ listId, x, y }) => wrap(() => updateListPosition(listId, x, y)))

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
  }, ({ listId, title, boardId, id }) => wrap(() => createCard(listId, title, boardId, id)))

  server.registerTool('delete_card', {
    title: 'Delete card',
    description: 'Permanently deletes a card.',
    inputSchema: { cardId: z.string(), boardId: z.string() },
  }, ({ cardId, boardId }) => wrap(() => deleteCard(cardId, boardId)))

  server.registerTool('update_card', {
    title: 'Update card',
    description: 'Updates a card\'s title and/or description.',
    inputSchema: {
      cardId:      z.string(),
      boardId:     z.string(),
      title:       z.string().optional(),
      description: z.string().optional(),
    },
  }, ({ cardId, boardId, title, description }) => wrap(() => updateCard(cardId, { title, description }, boardId)))

  server.registerTool('update_card_done', {
    title: 'Update card done',
    description: 'Marks a card as done or not done.',
    inputSchema: { cardId: z.string(), done: z.boolean(), boardId: z.string() },
  }, ({ cardId, done, boardId }) => wrap(() => updateCardDone(cardId, done, boardId)))

  server.registerTool('set_card_deadline', {
    title: 'Set card deadline',
    description: 'Sets or clears a card\'s deadline (clears recurrence).',
    inputSchema: {
      cardId:   z.string(),
      deadline: z.string().nullable().describe('ISO date string or null to clear'),
      boardId:  z.string(),
    },
  }, ({ cardId, deadline, boardId }) => wrap(() => setCardDeadline(cardId, deadline, boardId)))

  server.registerTool('set_card_recur', {
    title: 'Set card recurrence',
    description: 'Sets or clears the recurrence interval on a card (in minutes). Clears deadline.',
    inputSchema: {
      cardId:          z.string(),
      intervalMinutes: z.number().nullable().describe('Minutes between recurrences, or null to clear'),
      boardId:         z.string(),
    },
  }, ({ cardId, intervalMinutes, boardId }) => wrap(() => setCardRecur(cardId, intervalMinutes, boardId)))

  server.registerTool('set_card_hidden', {
    title: 'Set card hidden',
    description: 'Shows or hides a card.',
    inputSchema: { cardId: z.string(), hidden: z.boolean(), boardId: z.string() },
  }, ({ cardId, hidden, boardId }) => wrap(() => setCardHidden(cardId, hidden, boardId)))

  server.registerTool('move_card', {
    title: 'Move card',
    description: 'Moves a card to a different list and/or position.',
    inputSchema: {
      cardId:      z.string(),
      newListId:   z.string(),
      newPosition: z.number(),
      boardId:     z.string(),
    },
  }, ({ cardId, newListId, newPosition, boardId }) => wrap(() => moveCard(cardId, newListId, newPosition, boardId)))

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
  }, ({ updates, boardId }) => wrap(() => reorderCards(updates, boardId)))

  server.registerTool('update_card_position', {
    title: 'Update card position',
    description: 'Sets the canvas X/Y position of a card (free-mode).',
    inputSchema: { cardId: z.string(), x: z.number(), y: z.number() },
  }, ({ cardId, x, y }) => wrap(() => updateCardPosition(cardId, x, y)))

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
  }, ({ listId, title, boardId, x, y }) => wrap(() => createFreeCard(listId, title, boardId, x, y)))

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
  }, ({ boardId, type, x, y, data, width, height }) => wrap(() => createElement(boardId, type, x, y, data, width, height)))

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
  }, ({ elementId, ...updates }) => wrap(() => updateElement(elementId, updates)))

  server.registerTool('delete_element', {
    title: 'Delete element',
    description: 'Permanently deletes a canvas element.',
    inputSchema: { elementId: z.string() },
  }, ({ elementId }) => wrap(() => deleteElement(elementId)))

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
  }, ({ boardId, name, content, x, y }) => wrap(() => createTextFile(boardId, name, content, x, y)))

  server.registerTool('update_text_file', {
    title: 'Update text file',
    description: 'Updates the name and content of a text file element.',
    inputSchema: {
      elementId: z.string(),
      name:      z.string(),
      content:   z.string(),
      boardId:   z.string(),
    },
  }, ({ elementId, name, content, boardId }) => wrap(() => updateTextFile(elementId, name, content, boardId)))

  server.registerTool('move_element_to_board', {
    title: 'Move element to board',
    description: 'Moves a canvas element to a different board (resets its position to origin).',
    inputSchema: {
      elementId:     z.string(),
      targetBoardId: z.string(),
      fromBoardId:   z.string().optional(),
    },
  }, ({ elementId, targetBoardId, fromBoardId }) => wrap(() => moveElementToBoard(elementId, targetBoardId, fromBoardId)))

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
  }, ({ id, boardId, type, x, y, data, width, height }) => wrap(() => upsertElement(id, boardId, type, x, y, data, width, height)))

  server.registerTool('reorder_folder_items', {
    title: 'Reorder folder items',
    description: 'Bulk-reorders sub-folders and files within a folder board.',
    inputSchema: {
      parentBoardId: z.string(),
      folderIds:     z.array(z.string()).describe('Ordered list of child board IDs'),
      fileIds:       z.array(z.string()).describe('Ordered list of file element IDs'),
    },
  }, ({ parentBoardId, folderIds, fileIds }) => wrap(() => reorderFolderItems(parentBoardId, folderIds, fileIds)))

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
  }, ({ boardId, source, target, sourceHandle, targetHandle }) => wrap(() => createEdge(boardId, source, target, sourceHandle, targetHandle)))

  server.registerTool('delete_edge', {
    title: 'Delete edge',
    description: 'Deletes a canvas edge/connection.',
    inputSchema: { edgeId: z.string() },
  }, ({ edgeId }) => wrap(() => deleteEdge(edgeId)))

  server.registerTool('update_edge_shape', {
    title: 'Update edge shape',
    description: 'Updates the shape data of an edge (e.g. bend control point).',
    inputSchema: {
      edgeId: z.string(),
      data:   z.record(z.string(), z.unknown()).describe('Edge shape data, e.g. { cx, cy } for quadratic bend'),
    },
  }, ({ edgeId, data }) => wrap(() => updateEdgeShape(edgeId, data)))

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
  }, ({ id, boardId, source, target, sourceHandle, targetHandle }) => wrap(() => upsertEdge(id, boardId, source, target, sourceHandle, targetHandle)))

  // ── PDFs ────────────────────────────────────────────────────────────────────

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
  }, ({ name }) => wrap(() => createDeviceLink(name)))

  server.registerTool('remove_device_link', {
    title: 'Remove device link',
    description: 'Removes a paired or unpaired device link.',
    inputSchema: { id: z.string().describe('Device link ID') },
  }, ({ id }) => wrap(() => removeDeviceLink(id)))

  // ── User settings ───────────────────────────────────────────────────────────

  server.registerTool('save_anthropic_key', {
    title: 'Save Anthropic key',
    description: 'Encrypts and saves the user\'s Anthropic API key.',
    inputSchema: { key: z.string().describe('Anthropic API key (must start with sk-ant-)') },
  }, ({ key }) => wrap(() => saveAnthropicKey(key)))

  server.registerTool('remove_anthropic_key', {
    title: 'Remove Anthropic key',
    description: 'Removes the stored Anthropic API key.',
    inputSchema: undefined,
  }, () => wrap(() => removeAnthropicKey()))

  server.registerTool('set_claude_auto_apply', {
    title: 'Set Claude auto-apply',
    description: 'Toggles whether Claude is allowed to make write changes (true = writes enabled).',
    inputSchema: { enabled: z.boolean() },
  }, ({ enabled }) => wrap(() => setClaudeAutoApply(enabled)))

  server.registerTool('get_claude_status', {
    title: 'Get Claude status',
    description: 'Returns whether an Anthropic key is stored and whether auto-apply is on.',
    inputSchema: undefined,
  }, () => wrap(() => getClaudeStatus()))

  server.registerTool('set_stocks_enabled', {
    title: 'Set stocks enabled',
    description: 'Enables or disables the Stock Viewer feature for the user.',
    inputSchema: { enabled: z.boolean() },
  }, ({ enabled }) => wrap(() => setStocksEnabled(enabled)))

  server.registerTool('get_stocks_enabled', {
    title: 'Get stocks enabled',
    description: 'Returns whether the Stock Viewer feature is enabled for the user.',
    inputSchema: undefined,
  }, () => wrap(() => getStocksEnabled()))

  return server
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function handle(req: NextRequest): Promise<Response> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const origin = new URL(req.url).origin
  const cookie = req.headers.get('cookie') ?? ''

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = buildServer(cookie, origin, supabase, user.id)
  await server.connect(transport)
  return transport.handleRequest(req)
}

export const GET    = handle
export const POST   = handle
export const DELETE = handle
