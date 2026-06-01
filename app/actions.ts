'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

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

export async function createBoard(name: string, color: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const maxPos = await supabase
    .from('boards')
    .select('id')
    .eq('user_id', user.id)

  const { data, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id })
    .select()
    .single()

  if (error) throw error
  revalidatePath('/', 'layout')
  return data
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

export async function createSubTab(parentBoardId: string, name: string, color: string, mode: 'classic' | 'trello' | 'text' | 'folder' = 'classic') {
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

export async function updateBoard(boardId: string, updates: { name?: string; color?: string; deadline?: string | null; mode?: string }) {
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

  await Promise.all(updates)
  revalidatePath(`/board/${boardId}`)
}

// ── Lists ────────────────────────────────────────────────────────────────────

export async function createList(boardId: string, name: string) {
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
    .insert({ board_id: boardId, name, position })
    .select()
    .single()

  if (error) throw error
  revalidatePath(`/board/${boardId}`)
  return data
}

export async function deleteList(listId: string, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').delete().eq('id', listId)
  revalidatePath(`/board/${boardId}`)
}

export async function renameList(listId: string, name: string, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ name }).eq('id', listId)
  revalidatePath(`/board/${boardId}`)
}

export async function setListWidget(listId: string, isWidget: boolean, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ is_widget: isWidget }).eq('id', listId)
  revalidatePath(`/board/${boardId}`)
}

export async function setListDeadline(listId: string, deadline: string | null, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ deadline }).eq('id', listId)
  revalidatePath(`/board/${boardId}`)
}

export async function setListHidden(listId: string, hidden: boolean, boardId: string) {
  const supabase = await createClient()
  await supabase.from('lists').update({ hidden }).eq('id', listId)
  revalidatePath(`/board/${boardId}`)
}

// ── Cards ────────────────────────────────────────────────────────────────────

export async function createCard(listId: string, title: string, boardId: string) {
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
    .insert({ list_id: listId, title, position })
    .select()
    .single()

  if (error) throw error
  revalidatePath(`/board/${boardId}`)
  return data
}

export async function deleteCard(cardId: string, boardId: string) {
  const supabase = await createClient()
  await supabase.from('cards').delete().eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

export async function updateCard(cardId: string, updates: { title?: string; description?: string }, boardId: string) {
  const supabase = await createClient()
  await supabase.from('cards').update(updates).eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

export async function updateCardDone(cardId: string, done: boolean, boardId: string) {
  const supabase = await createClient()
  // Stamp done_at so recurring cards know when the current cycle started.
  await supabase.from('cards').update({ done, done_at: done ? new Date().toISOString() : null }).eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

export async function setCardDeadline(cardId: string, deadline: string | null, boardId: string) {
  const supabase = await createClient()
  // Expiry and recurrence are mutually exclusive — setting an expiry clears recurrence.
  const updates: Record<string, unknown> = { deadline }
  if (deadline) updates.recur_interval_minutes = null
  await supabase.from('cards').update(updates).eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

// Set (or clear, with null) a recurrence interval in minutes. When a card
// recurs, checking it off resets to undone after the interval elapses.
export async function setCardRecur(cardId: string, intervalMinutes: number | null, boardId: string) {
  const supabase = await createClient()
  const updates: Record<string, unknown> = { recur_interval_minutes: intervalMinutes }
  // Recurrence and expiry are mutually exclusive.
  if (intervalMinutes != null) updates.deadline = null
  await supabase.from('cards').update(updates).eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

export async function setCardHidden(cardId: string, hidden: boolean, boardId: string) {
  const supabase = await createClient()
  await supabase.from('cards').update({ hidden }).eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

export async function moveCard(
  cardId: string,
  newListId: string,
  newPosition: number,
  boardId: string
) {
  const supabase = await createClient()
  await supabase.from('cards').update({ list_id: newListId, position: newPosition }).eq('id', cardId)
  revalidatePath(`/board/${boardId}`)
}

export async function reorderCards(
  updates: { id: string; list_id: string; position: number }[],
  boardId: string
) {
  const supabase = await createClient()
  await Promise.all(
    updates.map(u =>
      supabase.from('cards').update({ list_id: u.list_id, position: u.position }).eq('id', u.id)
    )
  )
  revalidatePath(`/board/${boardId}`)
}

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

// ── Free mode: elements (shapes, images, drawings) ───────────────────────────

export async function createElement(
  boardId: string,
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile',
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
  revalidatePath(`/board/${boardId}`)
  return data
}

export async function updateTextFile(elementId: string, name: string, content: string, boardId: string) {
  const supabase = await createClient()
  // Preserve any other data keys (e.g. hidden/opacity from the canvas view).
  const { data: existing } = await supabase.from('board_elements').select('data').eq('id', elementId).single()
  const merged = { ...(existing?.data ?? {}), name, content }
  await supabase.from('board_elements').update({ data: merged }).eq('id', elementId)
  revalidatePath(`/board/${boardId}`)
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
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile',
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
