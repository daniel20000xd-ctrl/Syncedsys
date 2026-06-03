'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { encryptSecret } from '@/lib/crypto'

// ── Claude / AI settings ──────────────────────────────────────────────────────

// Save (or replace) the user's Anthropic API key. The plaintext key is encrypted
// server-side and never stored or returned in the clear.
// Returns a structured result rather than throwing, so the real failure reason
// survives to the client even in production (where Next.js strips thrown
// server-action error messages into a generic digest).
export async function saveAnthropicKey(key: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  const trimmed = key.trim()
  if (!trimmed.startsWith('sk-ant-')) return { ok: false, error: 'That does not look like an Anthropic API key (it should start with "sk-ant-").' }

  let encrypted: string
  try {
    encrypted = encryptSecret(trimmed)
  } catch (e) {
    return { ok: false, error: `Encryption failed: ${e instanceof Error ? e.message : 'unknown'}. (Is APP_ENCRYPTION_KEY set on the server?)` }
  }

  const { error } = await supabase
    .from('user_secrets')
    .upsert({ user_id: user.id, anthropic_key_encrypted: encrypted, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { ok: false, error: `Database error: ${error.message}` }

  revalidatePath('/settings')
  return { ok: true }
}

export async function removeAnthropicKey() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('user_secrets').update({ anthropic_key_encrypted: null }).eq('user_id', user.id)
  revalidatePath('/settings')
}

// Toggle whether Claude is allowed to make changes (write actions). When false,
// Claude is read-only. Scope (down-only board access) is always enforced.
export async function setClaudeAutoApply(enabled: boolean) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('user_secrets')
    .upsert({ user_id: user.id, claude_auto_apply: enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
  revalidatePath('/settings')
}

// Status for the settings UI — never returns the key itself, only whether one exists.
export async function getClaudeStatus(): Promise<{ hasKey: boolean; autoApply: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { hasKey: false, autoApply: false }
  const { data } = await supabase
    .from('user_secrets')
    .select('anthropic_key_encrypted, claude_auto_apply')
    .eq('user_id', user.id)
    .maybeSingle()
  return { hasKey: !!data?.anthropic_key_encrypted, autoApply: !!data?.claude_auto_apply }
}

// ── iOS sync / device links ──────────────────────────────────────────────────

export async function setBoardSynced(boardId: string, synced: boolean) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('boards').update({ synced }).eq('id', boardId).eq('user_id', user.id)
  revalidatePath('/', 'layout')
}

// Create a pending device link; returns the short pairing code to enter in the iOS app
export async function createDeviceLink(name = 'iOS device') {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '')
  const { data, error } = await supabase
    .from('device_links')
    .insert({ user_id: user.id, name, pairing_code: code, token })
    .select().single()
  if (error) throw error
  revalidatePath('/', 'layout')
  return { code, id: data.id as string }
}

export async function removeDeviceLink(id: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('device_links').delete().eq('id', id).eq('user_id', user.id)
  revalidatePath('/', 'layout')
}

// ── Boards ──────────────────────────────────────────────────────────────────

export async function createBoard(name: string, color: string, mode = 'classic') {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Append to the end of the top-level tab order.
  const { data: last } = await supabase
    .from('boards').select('tab_position').eq('user_id', user.id).is('parent_id', null).is('group_id', null)
    .order('tab_position', { ascending: false }).limit(1)
  const tab_position = last && last.length > 0 ? last[0].tab_position + 1 : 0

  const { data, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id, tab_position, mode })
    .select()
    .single()

  if (error) throw error
  revalidatePath('/', 'layout')
  return data
}

// ── Tab groups (symbolic groupings in the tab bar) ────────────────────────────

// A group is a board with is_group=true; members link via group_id (soft —
// deleting the group nulls members' group_id, never deletes them).
export async function createGroup(name: string, color: string, mode: 'folder' | 'classic', parentGroupId: string | null = null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  if (parentGroupId) {
    const { data: parent } = await supabase.from('boards').select('group_id').eq('id', parentGroupId).single()
    if (parent?.group_id) throw new Error('Groups can only be nested two levels deep')
  }

  let posQ = supabase.from('boards').select('tab_position').eq('user_id', user.id).is('parent_id', null)
  posQ = parentGroupId ? posQ.eq('group_id', parentGroupId) : posQ.is('group_id', null)
  const { data: last } = await posQ.order('tab_position', { ascending: false }).limit(1)
  const tab_position = last && last.length > 0 ? last[0].tab_position + 1 : 0

  const { data, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id, is_group: true, mode, group_id: parentGroupId, tab_position })
    .select().single()
  if (error) throw error
  revalidatePath('/', 'layout')
  return data
}

// Move a tab (board or group) into a container (a group, or top level when
// newGroupId is null) and reorder it before `beforeBoardId` (or to the end).
export async function moveTab(boardId: string, newGroupId: string | null, beforeBoardId: string | null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  if (boardId === newGroupId) return

  const { data: moving } = await supabase.from('boards').select('is_group').eq('id', boardId).single()
  if (moving?.is_group && newGroupId) {
    // A group may only live inside a top-level group (max two levels).
    const { data: target } = await supabase.from('boards').select('group_id, is_group').eq('id', newGroupId).single()
    if (!target?.is_group) throw new Error('Can only group into a group')
    if (target.group_id) throw new Error('Groups can only be nested two levels deep')
  }

  await supabase.from('boards').update({ group_id: newGroupId }).eq('id', boardId).eq('user_id', user.id)

  let q = supabase.from('boards').select('id').eq('user_id', user.id).is('parent_id', null)
  q = newGroupId ? q.eq('group_id', newGroupId) : q.is('group_id', null)
  const { data: sibs } = await q.order('tab_position', { ascending: true }).order('created_at', { ascending: true })
  const ids = (sibs ?? []).map(s => s.id).filter(id => id !== boardId)
  let idx = beforeBoardId ? ids.indexOf(beforeBoardId) : ids.length
  if (idx < 0) idx = ids.length
  ids.splice(idx, 0, boardId)
  await Promise.all(ids.map((id, i) => supabase.from('boards').update({ tab_position: i }).eq('id', id)))
  revalidatePath('/', 'layout')
}

export async function updateBoardFreePosition(boardId: string, x: number, y: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('boards').update({ free_x: x, free_y: y }).eq('id', boardId).eq('user_id', user.id)
}

export async function updateBoardContent(boardId: string, content: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('boards').update({ content }).eq('id', boardId).eq('user_id', user.id)
}

export async function createSubTab(parentBoardId: string, name: string, color: string, mode: 'classic' | 'trello' | 'text' | 'folder' | 'spreadsheet' = 'classic') {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: existing } = await supabase
    .from('boards')
    .select('tab_position')
    .eq('parent_id', parentBoardId)
    .order('tab_position', { ascending: false })
    .limit(1)

  const tab_position = existing && existing.length > 0 ? existing[0].tab_position + 1 : 0

  const { data, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id, parent_id: parentBoardId, tab_position, mode })
    .select()
    .single()

  if (error) throw error
  revalidatePath('/', 'layout')
  return data
}

export async function deleteBoard(boardId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase.from('boards').delete().eq('id', boardId).eq('user_id', user.id)
  revalidatePath('/', 'layout')
}

export async function renameBoard(boardId: string, name: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase.from('boards').update({ name }).eq('id', boardId).eq('user_id', user.id)
  revalidatePath('/', 'layout')
}

export async function updateBoard(boardId: string, updates: { name?: string; color?: string; deadline?: string | null; mode?: string; meta?: string | null }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('boards')
    .update(updates)
    .eq('id', boardId)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) throw error
  revalidatePath('/', 'layout')
  return data
}

// Spread a board's lists and cards into a kanban-style grid on the canvas.
// Used when switching Trello → Classic, where items would otherwise pile up at
// (0,0). Only repositions items still sitting at the origin so a hand-arranged
// classic layout is never clobbered.
export async function layoutBoardGrid(boardId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: lists } = await supabase
    .from('lists').select('id, position, x, y').eq('board_id', boardId).order('position', { ascending: true })
  if (!lists || lists.length === 0) return

  const { data: cards } = await supabase
    .from('cards').select('id, list_id, position, x, y').in('list_id', lists.map(l => l.id)).order('position', { ascending: true })

  const COL_W = 280, ROW_H = 64, CARD_TOP = 96, GAP = 40
  const updates: PromiseLike<unknown>[] = []

  lists.forEach((l, i) => {
    const lx = GAP + i * COL_W
    if (l.x === 0 && l.y === 0) {
      updates.push(supabase.from('lists').update({ x: lx, y: GAP }).eq('id', l.id))
    }
    const listCards = (cards ?? []).filter(c => c.list_id === l.id)
    listCards.forEach((c, j) => {
      if (c.x === 0 && c.y === 0) {
        updates.push(supabase.from('cards').update({ x: lx, y: CARD_TOP + j * ROW_H }).eq('id', c.id))
      }
    })
  })

  await Promise.all(updates)}

// ── Lists ────────────────────────────────────────────────────────────────────

export async function createList(boardId: string, name: string, id?: string) {
  const supabase = await createClient()

  const { data: existing } = await supabase
    .from('lists')
    .select('position')
    .eq('board_id', boardId)
    .order('position', { ascending: false })
    .limit(1)

  const position = existing && existing.length > 0 ? existing[0].position + 1 : 0

  const { data, error } = await supabase
    .from('lists')
    .insert({ ...(id ? { id } : {}), board_id: boardId, name, position })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function deleteList(listId: string, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').delete().eq('id', listId)}

export async function renameList(listId: string, name: string, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ name }).eq('id', listId)}

export async function setListWidget(listId: string, isWidget: boolean, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ is_widget: isWidget }).eq('id', listId)}

export async function setListDeadline(listId: string, deadline: string | null, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ deadline }).eq('id', listId)}

export async function setListHidden(listId: string, hidden: boolean, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ hidden }).eq('id', listId)}

// ── Cards ────────────────────────────────────────────────────────────────────

export async function createCard(listId: string, title: string, boardId: string, id?: string) {
  const supabase = await createClient()

  const { data: existing } = await supabase
    .from('cards')
    .select('position')
    .eq('list_id', listId)
    .order('position', { ascending: false })
    .limit(1)

  const position = existing && existing.length > 0 ? existing[0].position + 1 : 0

  const { data, error } = await supabase
    .from('cards')
    .insert({ ...(id ? { id } : {}), list_id: listId, title, position })
    .select()
    .single()

  if (error) throw error
  return data
}

export async function deleteCard(cardId: string, boardId: string) {
  const supabase = await createClient()
  await supabase.from('cards').delete().eq('id', cardId)}

export async function updateCard(cardId: string, updates: { title?: string; description?: string }, boardId: string) {
  const supabase = await createClient()
  await supabase.from('cards').update(updates).eq('id', cardId)}

export async function updateCardDone(cardId: string, done: boolean, boardId: string) {
  const supabase = await createClient()
  // Stamp done_at so recurring cards know when the current cycle started.
  await supabase.from('cards').update({ done, done_at: done ? new Date().toISOString() : null }).eq('id', cardId)}

export async function setCardDeadline(cardId: string, deadline: string | null, boardId: string) {
  const supabase = await createClient()
  // Expiry and recurrence are mutually exclusive — setting an expiry clears recurrence.
  const updates: Record<string, unknown> = { deadline }
  if (deadline) updates.recur_interval_minutes = null
  await supabase.from('cards').update(updates).eq('id', cardId)}

// Set (or clear, with null) a recurrence interval in minutes. When a card
// recurs, checking it off resets to undone after the interval elapses.
export async function setCardRecur(cardId: string, intervalMinutes: number | null, boardId: string) {
  const supabase = await createClient()
  const updates: Record<string, unknown> = { recur_interval_minutes: intervalMinutes }
  // Recurrence and expiry are mutually exclusive.
  if (intervalMinutes != null) updates.deadline = null
  await supabase.from('cards').update(updates).eq('id', cardId)}

export async function setCardHidden(cardId: string, hidden: boolean, boardId: string) {
  const supabase = await createClient()
  await supabase.from('cards').update({ hidden }).eq('id', cardId)}

export async function moveCard(
  cardId: string,
  newListId: string,
  newPosition: number,
  boardId: string
) {
  const supabase = await createClient()
  await supabase.from('cards').update({ list_id: newListId, position: newPosition }).eq('id', cardId)}

export async function reorderCards(
  updates: { id: string; list_id: string; position: number }[],
  boardId: string
) {
  const supabase = await createClient()
  await Promise.all(
    updates.map(u =>
      supabase.from('cards').update({ list_id: u.list_id, position: u.position }).eq('id', u.id)
    )
  )}

// ── Free mode: positions ──────────────────────────────────────────────────────

export async function updateListPosition(listId: string, x: number, y: number) {
  const supabase = await createClient()
  await supabase.from('lists').update({ x, y }).eq('id', listId)
}

export async function updateCardPosition(cardId: string, x: number, y: number) {
  const supabase = await createClient()
  await supabase.from('cards').update({ x, y }).eq('id', cardId)
}

export async function createFreeCard(listId: string, title: string, boardId: string, x: number, y: number) {
  const supabase = await createClient()
  const { data: existing } = await supabase.from('cards').select('position').eq('list_id', listId).order('position', { ascending: false }).limit(1)
  const position = existing && existing.length > 0 ? existing[0].position + 1 : 0
  const { data, error } = await supabase.from('cards').insert({ list_id: listId, title, position, x, y }).select().single()
  if (error) throw error
  return data
}

// ── Free mode: edges ──────────────────────────────────────────────────────────

export async function createEdge(boardId: string, source: string, target: string, sourceHandle?: string, targetHandle?: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('board_edges')
    .insert({ board_id: boardId, source, target, source_handle: sourceHandle ?? null, target_handle: targetHandle ?? null })
    .select().single()
  if (error) throw error
  return data
}

export async function deleteEdge(edgeId: string) {
  const supabase = await createClient()
  await supabase.from('board_edges').delete().eq('id', edgeId)
}

export async function updateEdgeShape(edgeId: string, data: Record<string, unknown>) {
  const supabase = await createClient()
  await supabase.from('board_edges').update({ data }).eq('id', edgeId)
}

// Insert-or-update an edge by id (used by undo/redo to restore by original id)
export async function upsertEdge(id: string, boardId: string, source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('board_edges')
    .upsert({ id, board_id: boardId, source, target, source_handle: sourceHandle ?? null, target_handle: targetHandle ?? null })
  if (error) throw error
}

// ── PDFs ─────────────────────────────────────────────────────────────────────

// Mint a short-lived signed URL for a stored PDF so it can be opened in a new
// tab. RLS on storage.objects ensures a user can only sign their own files.
export async function getPdfUrl(path: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  const { data, error } = await supabase.storage.from('pdfs').createSignedUrl(path, 3600)
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not open PDF.' }
  return { ok: true, url: data.signedUrl }
}

// ── Free mode: elements (shapes, images, drawings) ───────────────────────────

export async function createElement(
  boardId: string,
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile' | 'folderlink' | 'claude' | 'pdf',
  x: number, y: number,
  data: Record<string, unknown>,
  width?: number, height?: number
) {
  const supabase = await createClient()
  const { data: el, error } = await supabase
    .from('board_elements')
    .insert({ board_id: boardId, type, x, y, data, width: width ?? null, height: height ?? null })
    .select().single()
  if (error) throw error
  return el
}

export async function updateElement(
  elementId: string,
  updates: { x?: number; y?: number; data?: Record<string, unknown>; width?: number; height?: number; deadline?: string | null }
) {
  const supabase = await createClient()
  await supabase.from('board_elements').update(updates).eq('id', elementId)
}

export async function deleteElement(elementId: string) {
  const supabase = await createClient()
  await supabase.from('board_elements').delete().eq('id', elementId)
}

// A text file is a board_element of type 'textfile' holding { name, content }.
// On a canvas it renders as a movable block; in a folder-mode board it renders
// as a file in the explorer grid. Same row, two views.
export async function createTextFile(boardId: string, name: string, content: string, x = 0, y = 0) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('board_elements')
    .insert({ board_id: boardId, type: 'textfile', x, y, data: { name, content } })
    .select().single()
  if (error) throw error
  return data
}

// Recreate a dropped folder tree under a parent board: each folder becomes a
// child board (mode 'folder'), each text file a 'textfile' element. Returns the
// top-level folder board so the caller can show it immediately.
type ImportNode = { name: string; files: { name: string; content: string }[]; dirs: ImportNode[] }

export async function importFolderTree(parentBoardId: string, tree: ImportNode, color: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  async function createDir(node: ImportNode, parentId: string, tabPos: number) {
    const { data: board, error } = await supabase
      .from('boards')
      .insert({ name: node.name, color, user_id: user!.id, parent_id: parentId, tab_position: tabPos, mode: 'folder' })
      .select().single()
    if (error) throw error
    if (node.files.length) {
      await supabase.from('board_elements').insert(
        node.files.map(f => ({ board_id: board.id, type: 'textfile', x: 0, y: 0, data: { name: f.name, content: f.content } }))
      )
    }
    for (let i = 0; i < node.dirs.length; i++) {
      await createDir(node.dirs[i], board.id, i)
    }
    return board
  }

  const { data: existing } = await supabase
    .from('boards').select('tab_position').eq('parent_id', parentBoardId).order('tab_position', { ascending: false }).limit(1)
  const tabPos = existing && existing.length > 0 ? existing[0].tab_position + 1 : 0

  const top = await createDir(tree, parentBoardId, tabPos)
  revalidatePath(`/board/${parentBoardId}`)
  return top
}

// Deep-copy a board subtree (board + lists/cards/elements/edges + descendant
// boards) under a destination parent. Used to drag a folder out of a portal
// onto a canvas. Returns the new top-level board. Edge endpoints are remapped
// to the cloned node ids so connections survive the copy.
export async function copyBoardInto(sourceBoardId: string, destParentBoardId: string, freeX = 100, freeY = 100) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: src } = await supabase.from('boards').select('id').eq('id', sourceBoardId).eq('user_id', user.id).single()
  if (!src) throw new Error('Source board not found')
  const { data: dst } = await supabase.from('boards').select('id').eq('id', destParentBoardId).eq('user_id', user.id).single()
  if (!dst) throw new Error('Destination board not found')

  async function cloneSubtree(srcId: string, parentId: string, tabPos: number, fx?: number, fy?: number) {
    const { data: b } = await supabase.from('boards').select('*').eq('id', srcId).single()
    if (!b) throw new Error('Board missing')
    const { data: nb, error } = await supabase.from('boards').insert({
      name: b.name, color: b.color, mode: b.mode, content: b.content, user_id: user!.id,
      parent_id: parentId, tab_position: tabPos, free_x: fx ?? b.free_x, free_y: fy ?? b.free_y, deadline: b.deadline ?? null,
    }).select().single()
    if (error) throw error

    const { data: lists } = await supabase.from('lists').select('*').eq('board_id', srcId)
    const listMap = new Map<string, string>()
    for (const l of lists ?? []) {
      const { data: nl } = await supabase.from('lists').insert({
        board_id: nb.id, name: l.name, position: l.position, x: l.x, y: l.y,
        is_widget: l.is_widget, widget_position: l.widget_position, deadline: l.deadline, hidden: l.hidden,
      }).select('id').single()
      if (nl) listMap.set(l.id, nl.id)
    }

    const listIds = (lists ?? []).map(l => l.id)
    const cardMap = new Map<string, string>()
    if (listIds.length) {
      const { data: cards } = await supabase.from('cards').select('*').in('list_id', listIds)
      for (const c of cards ?? []) {
        const newListId = listMap.get(c.list_id)
        if (!newListId) continue
        const { data: nc } = await supabase.from('cards').insert({
          list_id: newListId, title: c.title, description: c.description, position: c.position, x: c.x, y: c.y,
          done: c.done, done_at: c.done_at, deadline: c.deadline, recur_interval_minutes: c.recur_interval_minutes, hidden: c.hidden,
        }).select('id').single()
        if (nc) cardMap.set(c.id, nc.id)
      }
    }

    const { data: els } = await supabase.from('board_elements').select('*').eq('board_id', srcId)
    const elMap = new Map<string, string>()
    for (const el of els ?? []) {
      const { data: ne } = await supabase.from('board_elements').insert({
        board_id: nb.id, type: el.type, x: el.x, y: el.y, width: el.width, height: el.height, data: el.data, deadline: el.deadline,
      }).select('id').single()
      if (ne) elMap.set(el.id, ne.id)
    }

    const remap = (ep: string) => {
      const i = ep.indexOf('-'); if (i < 0) return ep
      const p = ep.slice(0, i), oid = ep.slice(i + 1)
      if (p === 'list') return `list-${listMap.get(oid) ?? oid}`
      if (p === 'card') return `card-${cardMap.get(oid) ?? oid}`
      if (p === 'el') return `el-${elMap.get(oid) ?? oid}`
      return ep
    }
    const { data: edges } = await supabase.from('board_edges').select('*').eq('board_id', srcId)
    for (const e of edges ?? []) {
      await supabase.from('board_edges').insert({
        board_id: nb.id, source: remap(e.source), target: remap(e.target),
        source_handle: e.source_handle, target_handle: e.target_handle, data: e.data,
      })
    }

    const { data: kids } = await supabase.from('boards').select('id').eq('parent_id', srcId).order('tab_position', { ascending: true })
    for (let i = 0; i < (kids ?? []).length; i++) {
      await cloneSubtree(kids![i].id, nb.id, i)
    }
    return nb
  }

  const { data: existing } = await supabase.from('boards').select('tab_position').eq('parent_id', destParentBoardId).order('tab_position', { ascending: false }).limit(1)
  const tabPos = existing && existing.length > 0 ? existing[0].tab_position + 1 : 0
  const top = await cloneSubtree(sourceBoardId, destParentBoardId, tabPos, freeX, freeY)
  revalidatePath(`/board/${destParentBoardId}`)
  return top
}

// Re-parent a folder (board) under another board, or to the top level (null).
// Guards against moving a folder into itself or into one of its own
// descendants, which would create a cycle.
export async function moveBoardToParent(boardId: string, newParentId: string | null, fromParentId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  if (boardId === newParentId) throw new Error('Cannot move a folder into itself')

  if (newParentId) {
    const { data: tgt } = await supabase.from('boards').select('id').eq('id', newParentId).eq('user_id', user.id).single()
    if (!tgt) throw new Error('Target folder not found')
    // Walk up from the target; if we reach the folder being moved, it's a cycle.
    let cursor: string | null = newParentId
    const seen = new Set<string>()
    while (cursor) {
      if (cursor === boardId) throw new Error('Cannot move a folder into one of its own sub-folders')
      if (seen.has(cursor)) break
      seen.add(cursor)
      const { data: row }: { data: { parent_id: string | null } | null } =
        await supabase.from('boards').select('parent_id').eq('id', cursor).single()
      cursor = row?.parent_id ?? null
    }
  }

  let posQuery = supabase.from('boards').select('tab_position').eq('user_id', user.id).order('tab_position', { ascending: false }).limit(1)
  posQuery = newParentId ? posQuery.eq('parent_id', newParentId) : posQuery.is('parent_id', null)
  const { data: existing } = await posQuery
  const tab_position = existing && existing.length > 0 ? existing[0].tab_position + 1 : 0

  await supabase.from('boards').update({ parent_id: newParentId, tab_position }).eq('id', boardId).eq('user_id', user.id)
  if (fromParentId) revalidatePath(`/board/${fromParentId}`)
  if (newParentId) revalidatePath(`/board/${newParentId}`)
  revalidatePath('/', 'layout')
}

// Move an element (e.g. a text file) to another board the user owns — used to
// drag files between folders, or off a canvas into a folder. Resets position.
export async function moveElementToBoard(elementId: string, targetBoardId: string, fromBoardId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data: tgt } = await supabase.from('boards').select('id').eq('id', targetBoardId).eq('user_id', user.id).single()
  if (!tgt) throw new Error('Target board not found')
  await supabase.from('board_elements').update({ board_id: targetBoardId, x: 0, y: 0 }).eq('id', elementId)
  if (fromBoardId) revalidatePath(`/board/${fromBoardId}`)
  revalidatePath(`/board/${targetBoardId}`)
}

export async function updateTextFile(elementId: string, name: string, content: string, boardId: string) {
  const supabase = await createClient()
  // Preserve any other data keys (e.g. hidden/opacity from the canvas view).
  const { data: existing } = await supabase.from('board_elements').select('data').eq('id', elementId).single()
  const merged = { ...(existing?.data ?? {}), name, content }
  await supabase.from('board_elements').update({ data: merged }).eq('id', elementId)}

// Reorder items inside a folder view. folderIds / fileIds are the full ordered
// lists of board ids / element ids currently in this folder. Bulk-updates
// tab_position (boards) and position (board_elements) to match the new order.
export async function reorderFolderItems(
  parentBoardId: string,
  folderIds: string[],
  fileIds: string[],
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // For files we store sort order as folder_position inside the data JSONB blob
  // so no schema migration is needed.
  const fileUpdates = fileIds.map(async (id, i) => {
    const { data: existing } = await supabase.from('board_elements').select('data').eq('id', id).single()
    const merged = { ...(existing?.data ?? {}), folder_position: i }
    return supabase.from('board_elements').update({ data: merged }).eq('id', id)
  })

  await Promise.all([
    ...folderIds.map((id, i) =>
      supabase.from('boards').update({ tab_position: i }).eq('id', id).eq('user_id', user.id)
    ),
    ...fileUpdates,
  ])
  // No revalidatePath — the caller holds the source of truth in local state.
}

// Ensure the target board has a portal pointing back to the source board (mirror)
export async function ensureMirrorPortal(targetBoardId: string, backBoardId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  // Only mirror into boards the user owns
  const { data: tgt } = await supabase.from('boards').select('id').eq('id', targetBoardId).eq('user_id', user.id).single()
  if (!tgt) return
  const { data: existing } = await supabase
    .from('board_elements').select('id, data').eq('board_id', targetBoardId).eq('type', 'portal')
  const already = (existing ?? []).some(e => (e.data as { targetBoardId?: string } | null)?.targetBoardId === backBoardId)
  if (already) return
  await supabase.from('board_elements').insert({
    board_id: targetBoardId, type: 'portal', x: 80, y: 80, width: 320, height: 220,
    data: { targetBoardId: backBoardId, home: targetBoardId, vx: 20, vy: 20, zoom: 0.4 },
  })
}

// Insert-or-update an element by id (used by undo/redo to restore by original id)
export async function upsertElement(
  id: string,
  boardId: string,
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile' | 'folderlink' | 'claude' | 'pdf',
  x: number, y: number,
  data: Record<string, unknown>,
  width?: number | null, height?: number | null
) {
  const supabase = await createClient()
  const { error } = await supabase
    .from('board_elements')
    .upsert({ id, board_id: boardId, type, x, y, data, width: width ?? null, height: height ?? null })
  if (error) throw error
}

// ── Stock Viewer feature flag ─────────────────────────────────────────────────
// Stored in Supabase Auth user_metadata so no schema migration is ever needed.
// `supabase.auth.updateUser({ data: { ... } })` merges into raw_user_meta_data.

export async function getStocksEnabled(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return !!(user?.user_metadata?.stocks_enabled as boolean | undefined)
}

export async function setStocksEnabled(enabled: boolean): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase.auth.updateUser({ data: { stocks_enabled: enabled } })
  if (error) throw error
  revalidatePath('/settings/connected-apps')
  revalidatePath('/stocks')
}

// ── Account links ─────────────────────────────────────────────────────────────

export async function linkAccount(memberId: string, label: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  if (memberId === user.id) throw new Error('Cannot link to yourself')

  const { data, error } = await supabase
    .from('account_links')
    .insert({ owner_id: user.id, member_id: memberId, label: label.trim() || 'Linked account' })
    .select().single()

  if (error) {
    if (error.code === '23505') throw new Error('Already linked to this account')
    throw error
  }
  revalidatePath('/settings')
  return data
}

export async function acceptLink(linkId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase
    .from('account_links')
    .update({ status: 'accepted' })
    .eq('id', linkId)
    .eq('member_id', user.id)

  revalidatePath('/settings')
}

export async function removeLink(linkId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await supabase
    .from('account_links')
    .delete()
    .eq('id', linkId)
    .or(`owner_id.eq.${user.id},member_id.eq.${user.id}`)

  revalidatePath('/settings')
  revalidatePath('/overview')
}
