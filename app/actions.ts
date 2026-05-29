'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

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

export async function createSubTab(parentBoardId: string, name: string, color: string) {
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
    .insert({ name, color, user_id: user.id, parent_id: parentBoardId, tab_position })
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

// ── Free mode: elements (shapes, images, drawings) ───────────────────────────

export async function createElement(
  boardId: string,
  type: 'shape' | 'image' | 'drawing' | 'text',
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
  updates: { x?: number; y?: number; data?: Record<string, unknown>; width?: number; height?: number }
) {
  const supabase = await createClient()
  await supabase.from('board_elements').update(updates).eq('id', elementId)
}

export async function deleteElement(elementId: string) {
  const supabase = await createClient()
  await supabase.from('board_elements').delete().eq('id', elementId)
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
