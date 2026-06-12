'use server'

import { revalidatePath } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient, listAllAuthUsers } from '@/lib/supabase/admin'
import { encryptSecret, sha256Hex, randomToken } from '@/lib/crypto'
import { billableUsd, currentPeriodStartIso } from '@/lib/claude/pricing'
import { getAccountLimits } from '@/lib/limits'
import { isAdminEmail } from '@/lib/admin'
import { GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { getGoogleAuthUrl, revokeGoogleAccess, hasGoogleAuth, getGoogleScopes, DEFAULT_GOOGLE_SCOPES } from '@/lib/google/auth'
import { createUrlPreviewUnit } from '@/lib/urlPreview'
import type { ImportNode } from '@/lib/files'

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

// Opt in/out of paying for platform Claude usage beyond the free monthly allowance.
// Off by default — a non-opted-in user is capped at the free tier and never charged.
export async function setClaudePayPerUse(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  const { error } = await supabase
    .from('user_secrets')
    .upsert({ user_id: user.id, claude_pay_per_use: enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { ok: false, error: error.message }
  revalidatePath('/settings')
  return { ok: true }
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

// Per-user Claude usage for the settings card. Sums the user's own (append-only)
// ledger rows for the current billing period — the same source the admin invoice
// reads, so the two never diverge. spentUsd is raw cost; the first freeUsd of it is
// free, and owedUsd is the marked-up overage (0 unless opted in). Never returns the key.
export async function getClaudeUsage(): Promise<{
  keySource: 'user' | 'platform'
  hasOwnKey: boolean
  usingPlatform: boolean
  payPerUse: boolean
  freeUsd: number | null
  spentUsd: number
  owedUsd: number
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { apiCreditUsd } = getAccountLimits(user ?? null)
  if (!user) {
    return { keySource: 'platform', hasOwnKey: false, usingPlatform: false, payPerUse: false, freeUsd: apiCreditUsd, spentUsd: 0, owedUsd: 0 }
  }

  // Read the key flag on its own always-present column so a missing pay_per_use
  // column pre-migration can never flip the key-source indicator to the wrong value.
  const { data: keyRow } = await supabase
    .from('user_secrets').select('anthropic_key_encrypted').eq('user_id', user.id).maybeSingle()
  const hasOwnKey = !!keyRow?.anthropic_key_encrypted
  const usingPlatform = !hasOwnKey && !!process.env.ANTHROPIC_API_KEY

  // Pay-per-use is tolerant of the pre-migration absence of its column (→ false).
  const { data: payRow } = await supabase
    .from('user_secrets').select('claude_pay_per_use').eq('user_id', user.id).maybeSingle()
  const payPerUse = !!payRow?.claude_pay_per_use

  const { data: rows } = await supabase
    .from('claude_usage').select('cost_usd')
    .eq('user_id', user.id).eq('billable', true)
    .gte('created_at', currentPeriodStartIso())
  const list = (rows ?? []) as { cost_usd: number | string | null }[]
  const spentUsd = list.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)

  return {
    keySource: hasOwnKey ? 'user' : 'platform',
    hasOwnKey, usingPlatform, payPerUse, freeUsd: apiCreditUsd, spentUsd,
    owedUsd: billableUsd(spentUsd, payPerUse),
  }
}

export type ClaudeBillingRow = {
  userId: string
  email: string
  payPerUse: boolean
  spentRawUsd: number // raw Anthropic cost this period (includes the free portion)
  owedUsd: number // marked-up overage above the free allowance (0 if not opted in)
  requests: number
  inputTokens: number
  outputTokens: number
  lastUsed: string | null
}

// Admin-only: per-user platform spend for the CURRENT billing period, for invoicing.
// Uses the service-role client to read across all users (RLS would otherwise scope to
// the caller). owedUsd applies markup only to the overage above the free allowance,
// and only for users who opted into pay-per-use.
export async function getAdminClaudeBilling(): Promise<ClaudeBillingRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdminEmail(user?.email)) return []

  const admin = createAdminClient()
  const [allUsers, { data: rows }, { data: secrets }] = await Promise.all([
    listAllAuthUsers(admin),
    admin.from('claude_usage')
      .select('user_id, cost_usd, input_tokens, output_tokens, created_at')
      .eq('billable', true)
      .gte('created_at', currentPeriodStartIso()),
    admin.from('user_secrets').select('user_id, claude_pay_per_use'),
  ])

  const emailById = new Map(allUsers.map(u => [u.id, u.email ?? '(unknown)']))
  const payById = new Map(
    ((secrets ?? []) as { user_id: string; claude_pay_per_use: boolean | null }[])
      .map(s => [s.user_id, !!s.claude_pay_per_use]),
  )
  const agg = new Map<string, ClaudeBillingRow>()
  const list = (rows ?? []) as Array<{
    user_id: string; cost_usd: number | string | null
    input_tokens: number | null; output_tokens: number | null; created_at: string
  }>
  for (const r of list) {
    const cur = agg.get(r.user_id) ?? {
      userId: r.user_id,
      email: emailById.get(r.user_id) ?? '(unknown)',
      payPerUse: payById.get(r.user_id) ?? false,
      spentRawUsd: 0, owedUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0, lastUsed: null as string | null,
    }
    cur.spentRawUsd += Number(r.cost_usd ?? 0)
    cur.requests += 1
    cur.inputTokens += r.input_tokens ?? 0
    cur.outputTokens += r.output_tokens ?? 0
    if (!cur.lastUsed || r.created_at > cur.lastUsed) cur.lastUsed = r.created_at
    agg.set(r.user_id, cur)
  }
  for (const row of agg.values()) row.owedUsd = billableUsd(row.spentRawUsd, row.payPerUse)
  return [...agg.values()].sort((a, b) => b.owedUsd - a.owedUsd || b.spentRawUsd - a.spentRawUsd)
}

// ── Platform Claude kill switch (admin) ───────────────────────────────────────

// Read the global platform-Claude toggle. Defaults to enabled (fail-open) so a
// missing app_config row pre-migration doesn't take Claude down.
export async function getClaudeApiEnabled(): Promise<boolean> {
  const supabase = await createClient()
  const { data } = await supabase.from('app_config').select('enabled').eq('key', 'claude_api').maybeSingle()
  return data ? data.enabled !== false : true
}

// Flip the global platform-Claude kill switch. Admin-only; writes via the service
// role. When disabled, platform-key requests are refused; own-key users are unaffected.
export async function setClaudeApiEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdminEmail(user?.email)) return { ok: false, error: 'Not authorized.' }
  const admin = createAdminClient()
  const { error } = await admin.from('app_config')
    .upsert({ key: 'claude_api', enabled, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) {
    // Most likely app_config doesn't exist yet — run supabase/claude_usage.sql.
    return { ok: false, error: `Couldn't save: ${error.message}` }
  }
  revalidatePath('/admin')
  return { ok: true }
}

// ── MCP access tokens (bring your own Claude) ─────────────────────────────────
// Let the user connect their own Claude (Claude Code, the Claude apps) to the MCP
// without an Anthropic API key. Tokens are stored only as a SHA-256 hash; the
// plaintext is shown once at creation and is never recoverable.

type McpTokenRow = { id: string; name: string; created_at: string; last_used_at: string | null }

export async function createMcpToken(
  name?: string,
): Promise<{ ok: boolean; token?: string; row?: McpTokenRow; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  const token = randomToken()
  const { data, error } = await supabase
    .from('mcp_tokens')
    .insert({ user_id: user.id, token_hash: sha256Hex(token), name: name?.trim() || 'Claude' })
    .select('id, name, created_at, last_used_at')
    .single()
  if (error || !data) return { ok: false, error: `Database error: ${error?.message ?? 'insert failed'}` }
  revalidatePath('/settings')
  return { ok: true, token, row: data as McpTokenRow }
}

export async function listMcpTokens(): Promise<McpTokenRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const { data } = await supabase
    .from('mcp_tokens')
    .select('id, name, created_at, last_used_at')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
  return (data ?? []) as McpTokenRow[]
}

export async function revokeMcpToken(id: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('mcp_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', user.id)
  revalidatePath('/settings')
}

// ── iOS sync / device links ──────────────────────────────────────────────────

export async function setBoardSynced(boardId: string, synced: boolean) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('boards').update({ synced }).eq('id', boardId).eq('user_id', user.id)
  revalidatePath('/', 'layout')
}

// README is opt-in per board (off by default). Toggled from the board
// properties panel; gates whether the BoardReadme strip renders.
export async function setBoardReadmeEnabled(boardId: string, enabled: boolean) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  await supabase.from('boards').update({ readme_enabled: enabled }).eq('id', boardId).eq('user_id', user.id)
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

export async function createBoard(name: string, color: string, mode = 'classic', activePersonaId: string | null = null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Append to the end of the active persona's tab order (legacy root when null).
  let posQ = supabase.from('boards').select('tab_position').eq('user_id', user.id).is('group_id', null)
  posQ = activePersonaId ? posQ.eq('parent_id', activePersonaId) : posQ.is('parent_id', null)
  const { data: last } = await posQ.order('tab_position', { ascending: false }).limit(1)
  const tab_position = last && last.length > 0 ? last[0].tab_position + 1 : 0

  const { data, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id, parent_id: activePersonaId, tab_position, mode })
    .select()
    .single()

  if (error) throw error
  revalidatePath('/', 'layout')
  return data
}

// Create a new persona (top-level container) plus one empty canvas board to land
// on, so switching to it feels like a fresh account. Returns both rows.
export async function createPersona(name = 'New persona', color = '#6366f1') {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: last } = await supabase
    .from('boards').select('tab_position').eq('user_id', user.id).is('parent_id', null).eq('is_persona', true)
    .order('tab_position', { ascending: false }).limit(1)
  const tab_position = last && last.length > 0 ? last[0].tab_position + 1 : 0

  const { data: persona, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id, is_persona: true, parent_id: null, tab_position, mode: 'classic' })
    .select().single()
  if (error) throw error

  const { data: board, error: bErr } = await supabase
    .from('boards')
    .insert({ name: 'My First Board', color, user_id: user.id, parent_id: persona.id, tab_position: 0, mode: 'classic' })
    .select().single()
  if (bErr) throw bErr

  revalidatePath('/', 'layout')
  return { persona, board }
}

// Delete a persona and its entire subtree. Refuses to remove the last persona,
// deletes each top-level child via deleteBoard (which handles R2 + sub-trees),
// then removes the now-empty persona (the DB trigger blocks deleting a non-empty
// persona, so order matters).
export async function deletePersona(personaId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: persona } = await supabase
    .from('boards').select('*').eq('id', personaId).eq('user_id', user.id).maybeSingle()
  if (!persona || !(persona as { is_persona?: boolean }).is_persona) throw new Error('Not a persona')

  const { data: personas } = await supabase
    .from('boards').select('id').eq('user_id', user.id).eq('is_persona', true)
  if ((personas ?? []).length <= 1) throw new Error('You must keep at least one persona.')

  const { data: topChildren } = await supabase.from('boards').select('id').eq('parent_id', personaId)
  for (const c of topChildren ?? []) await deleteBoard(c.id)
  await supabase.from('boards').delete().eq('id', personaId).eq('user_id', user.id)
  revalidatePath('/', 'layout')
}

// ── Tab groups (symbolic groupings in the tab bar) ────────────────────────────

// A group is a board with is_group=true; members link via group_id (soft —
// deleting the group nulls members' group_id, never deletes them).
export async function createGroup(name: string, color: string, mode: 'folder' | 'classic', parentGroupId: string | null = null, activePersonaId: string | null = null) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  if (parentGroupId) {
    const { data: parent } = await supabase.from('boards').select('group_id').eq('id', parentGroupId).single()
    if (parent?.group_id) throw new Error('Groups can only be nested two levels deep')
  }

  // parent_id always scopes the group to the active persona; group_id does the
  // (orthogonal) nesting under another group.
  let posQ = supabase.from('boards').select('tab_position').eq('user_id', user.id)
  posQ = activePersonaId ? posQ.eq('parent_id', activePersonaId) : posQ.is('parent_id', null)
  posQ = parentGroupId ? posQ.eq('group_id', parentGroupId) : posQ.is('group_id', null)
  const { data: last } = await posQ.order('tab_position', { ascending: false }).limit(1)
  const tab_position = last && last.length > 0 ? last[0].tab_position + 1 : 0

  const { data, error } = await supabase
    .from('boards')
    .insert({ name, color, user_id: user.id, is_group: true, mode, group_id: parentGroupId, parent_id: activePersonaId, tab_position })
    .select().single()
  if (error) throw error
  revalidatePath('/', 'layout')
  return data
}

// Move a tab (board or group) into a container (a group, or top level when
// newGroupId is null) and reorder it before `beforeBoardId` (or to the end).
export async function moveTab(boardId: string, newGroupId: string | null, beforeBoardId: string | null, activePersonaId: string | null = null) {
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

  // Tabs stay parented to the active persona (not orphaned at the true root).
  await supabase.from('boards').update({ group_id: newGroupId, parent_id: activePersonaId }).eq('id', boardId).eq('user_id', user.id)

  let q = supabase.from('boards').select('id').eq('user_id', user.id)
  q = activePersonaId ? q.eq('parent_id', activePersonaId) : q.is('parent_id', null)
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

export async function createSubTab(parentBoardId: string, name: string, color: string, mode: 'classic' | 'trello' | 'text' | 'folder' | 'database' = 'classic') {
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

  // Never delete a persona through this path — it would cascade the whole
  // workspace. (select('*') so this is a no-op on the pre-migration schema.)
  const { data: target } = await supabase
    .from('boards').select('*').eq('id', boardId).eq('user_id', user.id).maybeSingle()
  if (target && (target as { is_persona?: boolean }).is_persona) {
    throw new Error('Cannot delete a persona here — use the persona switcher.')
  }

  // BFS to collect every board ID in the subtree before the cascade delete
  const allBoardIds: string[] = []
  const queue = [boardId]
  while (queue.length > 0) {
    const batch = queue.splice(0)
    allBoardIds.push(...batch)
    const { data: kids } = await supabase
      .from('boards').select('id').in('parent_id', batch)
    if (kids?.length) queue.push(...kids.map(k => k.id))
  }

  // Find every element across the subtree that has an R2 object.
  // Checking for storagePath rather than type so this works for any future
  // file type that follows the same storagePath/sizeBytes convention.
  const { data: els } = await supabase
    .from('board_elements').select('data').in('board_id', allBoardIds)

  // Only delete R2 objects under THIS user's prefix. storagePath is freeform
  // jsonb a caller could have set to another tenant's key; the read paths guard
  // the same way, so the delete paths must too (no cross-tenant object deletion).
  const storageItems = (els ?? [])
    .map(el => el.data as { storagePath?: string; sizeBytes?: number })
    .filter(d => !!d.storagePath && d.storagePath.startsWith(`${user.id}/`))

  if (storageItems.length > 0) {
    const keys = storageItems.map(d => d.storagePath!)
    const totalBytes = storageItems.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0)

    // Batch delete — DeleteObjectsCommand handles up to 1000 keys per call
    try {
      const chunks: string[][] = []
      for (let i = 0; i < keys.length; i += 1000) chunks.push(keys.slice(i, i + 1000))
      await Promise.all(chunks.map(chunk =>
        getR2Client().send(new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
        }))
      ))
    } catch {}

    if (totalBytes > 0) {
      const { data: secrets } = await supabase
        .from('user_secrets').select('storage_bytes').eq('user_id', user.id).maybeSingle()
      const current = (secrets?.storage_bytes as number | null) ?? 0
      await supabase.from('user_secrets').upsert(
        { user_id: user.id, storage_bytes: Math.max(0, current - totalBytes) },
        { onConflict: 'user_id' }
      )
    }
  }

  // Delete all boards in the subtree. children reference parents via parent_id,
  // but PostgreSQL checks FK constraints at statement end, so a single IN-delete
  // of the whole set works without ordering tricks.
  await supabase.from('boards').delete().in('id', allBoardIds).eq('user_id', user.id)
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

// Mint a short-lived presigned R2 URL for a stored PDF so it can be opened in
// a new tab. Enforces that the key belongs to the requesting user.
export async function getPdfUrl(key: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!key.startsWith(`${user.id}/`)) return { ok: false, error: 'Access denied.' }
  try {
    const url = await getSignedUrl(
      getR2Client(),
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: 3600 }
    )
    return { ok: true, url }
  } catch {
    return { ok: false, error: 'Could not open PDF.' }
  }
}

// Mint a short-lived presigned R2 URL for any stored object so the client can
// read its content. Enforces that the key belongs to the requesting user.
export async function getPresignedReadUrl(key: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  if (!key.startsWith(`${user.id}/`)) return { ok: false, error: 'Access denied.' }
  try {
    const url = await getSignedUrl(
      getR2Client(),
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: 3600 }
    )
    return { ok: true, url }
  } catch {
    return { ok: false, error: 'Could not read file.' }
  }
}

// ── Free mode: elements (shapes, images, drawings) ───────────────────────────

export async function createElement(
  boardId: string,
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile' | 'folderlink' | 'claude' | 'pdf' | 'url_preview' | 'file',
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

// Create an enriched url_preview element on a board. Thin server-action wrapper
// over the shared lib/urlPreview.ts action — used by the MCP create_url_preview
// tool. Ownership is enforced by RLS via the auth-scoped client (boards the user
// doesn't own reject the insert).
export async function createUrlPreview(boardId: string, url: string, x?: number, y?: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { id, data } = await createUrlPreviewUnit({ supabase, userId: user.id, boardId, url, x, y })
  return { id, title: data.title, domain: data.domain, status: data.status }
}

export async function deleteElement(elementId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Read before deleting so we can clean up any R2 object (pdf, image, textfile —
  // any element type that stores a storagePath).
  const { data: el } = await supabase
    .from('board_elements')
    .select('data')
    .eq('id', elementId)
    .maybeSingle()

  const d = el?.data as { storagePath?: string; sizeBytes?: number } | undefined
  // Only touch R2 for objects under this user's own prefix — storagePath is
  // freeform jsonb that could point at another tenant's key (read paths guard
  // identically, so the delete path must too).
  if (d?.storagePath && user && d.storagePath.startsWith(`${user.id}/`)) {
    try {
      await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: d.storagePath }))
    } catch {}
    if (d.sizeBytes) {
      const { data: secrets } = await supabase
        .from('user_secrets')
        .select('storage_bytes')
        .eq('user_id', user.id)
        .maybeSingle()
      const current = (secrets?.storage_bytes as number | null) ?? 0
      await supabase
        .from('user_secrets')
        .upsert(
          { user_id: user.id, storage_bytes: Math.max(0, current - d.sizeBytes) },
          { onConflict: 'user_id' }
        )
    }
  }

  await supabase.from('board_elements').delete().eq('id', elementId)
}

// Best-effort delete of R2 objects by key — used to clean up orphaned uploads
// (e.g. PDFs uploaded for a folder import whose DB persistence then failed).
// Only deletes keys under the caller's own prefix.
export async function deleteStorageObjects(keys: string[]): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const safe = Array.from(new Set(
    (keys ?? []).filter(k => typeof k === 'string' && k.startsWith(`${user.id}/`)),
  ))
  if (!safe.length) return
  try {
    const chunks: string[][] = []
    for (let i = 0; i < safe.length; i += 1000) chunks.push(safe.slice(i, i + 1000))
    await Promise.all(chunks.map(chunk =>
      getR2Client().send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
      }))
    ))
  } catch {}
}

// A text file is a board_element of type 'textfile'. Content lives in R2;
// the DB row holds { name, storagePath, sizeBytes }. Content is fetched via a
// presigned URL on demand. For empty new files there is no R2 object — just { name }.
export async function createTextFile(boardId: string, name: string, content: string, x = 0, y = 0) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  let elData: Record<string, unknown> = { name }

  if (content) {
    const key = `${user.id}/hub/textfiles/${crypto.randomUUID()}-${name}`
    const buf = Buffer.from(content, 'utf8')
    try {
      await getR2Client().send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: buf,
        ContentType: 'text/plain; charset=utf-8',
      }))
      const sizeBytes = buf.byteLength
      elData = { name, storagePath: key, sizeBytes }
      const { data: secrets } = await supabase.from('user_secrets').select('storage_bytes').eq('user_id', user.id).maybeSingle()
      const current = (secrets?.storage_bytes as number | null) ?? 0
      supabase.from('user_secrets').upsert({ user_id: user.id, storage_bytes: current + sizeBytes }, { onConflict: 'user_id' }).then(() => {})
    } catch {
      elData = { name, content } // R2 unavailable — fall back to DB
    }
  }

  const { data, error } = await supabase
    .from('board_elements')
    .insert({ board_id: boardId, type: 'textfile', x, y, data: elData })
    .select().single()
  if (error) throw error
  return data
}

// Recreate a folder tree under a parent board: each folder becomes a child board
// (mode 'folder'), each text file a 'textfile' element, and each already-uploaded
// PDF (R2 storagePath supplied by the caller) a 'pdf' element. Returns the
// top-level folder board so the caller can show it immediately.
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
    const elements: { board_id: string; type: string; x: number; y: number; data: Record<string, unknown> }[] = []
    // A single position counter across text files THEN pdfs so the within-folder
    // order is durable across reloads (FolderBoardView sorts by folder_position).
    let pos = 0
    for (const f of node.files) {
      elements.push({ board_id: board.id, type: 'textfile', x: 0, y: 0, data: { name: f.name, content: f.content, folder_position: pos++ } })
    }
    for (const p of node.pdfs ?? []) {
      elements.push({ board_id: board.id, type: 'pdf', x: 0, y: 0, data: { name: p.name, storagePath: p.storagePath, sizeBytes: p.sizeBytes, text: p.text, pageCount: p.pageCount, folder_position: pos++ } })
    }
    for (const b of node.binaries ?? []) {
      elements.push({ board_id: board.id, type: 'file', x: 0, y: 0, data: { name: b.name, storagePath: b.storagePath, sizeBytes: b.sizeBytes, folder_position: pos++ } })
    }
    if (elements.length) {
      await supabase.from('board_elements').insert(elements)
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
      let elData = el.data
      if (el.type === 'portal') {
        // Don't carry a portal's target across a copy — it may point outside this
        // subtree/persona. Re-home it to the clone and clear the target so the
        // user re-picks within the destination persona.
        elData = { ...(el.data as Record<string, unknown>), home: nb.id, targetBoardId: null, targetBoardName: null }
      }
      const { data: ne } = await supabase.from('board_elements').insert({
        board_id: nb.id, type: el.type, x: el.x, y: el.y, width: el.width, height: el.height, data: elData, deadline: el.deadline,
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
// Walk a board's parent_id chain server-side to find its persona root.
async function personaIdOf(supabase: SupabaseClient, boardId: string): Promise<string | null> {
  let cur: string | null = boardId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const { data }: { data: { id: string; parent_id: string | null; is_persona?: boolean } | null } =
      await supabase.from('boards').select('id, parent_id, is_persona').eq('id', cur).maybeSingle()
    if (!data) return null
    if (data.is_persona) return data.id
    cur = data.parent_id
  }
  return null
}

export async function moveBoardToParent(boardId: string, newParentId: string | null, fromParentId?: string, activePersonaId: string | null = null) {
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

  // Moving to "top level" means top level of the active persona, not the true
  // root. Prefer the caller's persona; otherwise derive it from the board's own
  // current ancestry (covers callers like FolderBoardView that lack the context).
  const effectiveParent = newParentId ?? activePersonaId ?? await personaIdOf(supabase, boardId)

  let posQuery = supabase.from('boards').select('tab_position').eq('user_id', user.id).order('tab_position', { ascending: false }).limit(1)
  posQuery = effectiveParent ? posQuery.eq('parent_id', effectiveParent) : posQuery.is('parent_id', null)
  const { data: existing } = await posQuery
  const tab_position = existing && existing.length > 0 ? existing[0].tab_position + 1 : 0

  await supabase.from('boards').update({ parent_id: effectiveParent, tab_position }).eq('id', boardId).eq('user_id', user.id)
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

export async function updateTextFile(elementId: string, name: string, content: string, _boardId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: existing } = await supabase.from('board_elements').select('data').eq('id', elementId).single()
  const existingData = (existing?.data ?? {}) as Record<string, unknown>
  const storagePath = existingData.storagePath as string | undefined

  let merged: Record<string, unknown>

  if (storagePath) {
    if (!content) {
      // Empty content on an R2 file = name-only rename; don't touch the object.
      merged = { ...existingData, name }
    } else {
      const buf = Buffer.from(content, 'utf8')
      try {
        await getR2Client().send(new PutObjectCommand({
          Bucket: R2_BUCKET, Key: storagePath, Body: buf,
          ContentType: 'text/plain; charset=utf-8',
        }))
        const oldSize = (existingData.sizeBytes as number | null) ?? 0
        const newSize = buf.byteLength
        merged = { ...existingData, name, sizeBytes: newSize }
        const delta = newSize - oldSize
        if (delta !== 0) {
          const { data: secrets } = await supabase.from('user_secrets').select('storage_bytes').eq('user_id', user.id).maybeSingle()
          const current = (secrets?.storage_bytes as number | null) ?? 0
          supabase.from('user_secrets').upsert({ user_id: user.id, storage_bytes: Math.max(0, current + delta) }, { onConflict: 'user_id' }).then(() => {})
        }
      } catch {
        merged = { ...existingData, name }
      }
    }
  } else if (content) {
    // Legacy DB-backed file: migrate to R2 on first meaningful save.
    const key = `${user.id}/hub/textfiles/${crypto.randomUUID()}-${name}`
    const buf = Buffer.from(content, 'utf8')
    try {
      await getR2Client().send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: buf,
        ContentType: 'text/plain; charset=utf-8',
      }))
      const sizeBytes = buf.byteLength
      merged = { ...existingData, name, storagePath: key, sizeBytes }
      delete merged.content
      const { data: secrets } = await supabase.from('user_secrets').select('storage_bytes').eq('user_id', user.id).maybeSingle()
      const current = (secrets?.storage_bytes as number | null) ?? 0
      supabase.from('user_secrets').upsert({ user_id: user.id, storage_bytes: current + sizeBytes }, { onConflict: 'user_id' }).then(() => {})
    } catch {
      merged = { ...existingData, name, content }
    }
  } else {
    merged = { ...existingData, name }
  }

  await supabase.from('board_elements').update({ data: merged }).eq('id', elementId)
}

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
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile' | 'folderlink' | 'claude' | 'pdf' | 'url_preview' | 'file',
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

// ── Google account (shared OAuth for Calendar, Sheets, Docs) ──────────────────

// Build the Google consent URL for the requested scopes (defaults to all of them
// — one consent screen for every integration). The client redirects to the URL.
export async function connectGoogleAccount(
  scopes: string[] = DEFAULT_GOOGLE_SCOPES,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  if (!redirectUri) return { ok: false, error: 'GOOGLE_REDIRECT_URI is not configured on the server.' }
  try {
    const url = getGoogleAuthUrl(user.id, scopes, redirectUri)
    return { ok: true, url }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not start Google sign-in.' }
  }
}

// Revoke the grant at Google and delete the stored tokens for the current user.
export async function disconnectGoogleAccount(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }
  try {
    await revokeGoogleAccess(user.id)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not disconnect Google.' }
  }
  revalidatePath('/settings/connected-apps')
  return { ok: true }
}

// Connection status for the settings UI.
export async function getGoogleConnectionStatus(): Promise<{ connected: boolean; scopes: string[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { connected: false, scopes: [] }
  const [connected, scopes] = await Promise.all([
    hasGoogleAuth(user.id),
    getGoogleScopes(user.id),
  ])
  return { connected, scopes }
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

// ── Float-board: fetch all data for a board to render it as a floating window ──
export async function loadBoardForFloat(boardId: string) {
  const supabase = await createClient()
  const [boardRes, subRes] = await Promise.all([
    supabase
      .from('boards')
      .select('*, lists(*, cards(*)), board_elements(*), board_edges(*)')
      .eq('id', boardId)
      .single(),
    supabase
      .from('boards')
      .select('*')
      .eq('parent_id', boardId)
      .order('tab_position', { ascending: true }),
  ])
  if (!boardRes.data) return null
  const board = boardRes.data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lists = ((board.lists ?? []) as any[]).sort((a: any, b: any) => a.position - b.position)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cards = lists.flatMap((l: any) => l.cards ?? []).sort((a: any, b: any) => a.position - b.position)
  const elements = board.board_elements ?? []
  const edges = board.board_edges ?? []
  const subBoards = subRes.data ?? []
  return { board, lists, cards, elements, edges, subBoards }
}

// ── R2 storage usage ──────────────────────────────────────────────────────────

export type StorageUsage = {
  totalBytes: number
  apps: Record<string, { bytes: number; count: number }>
}

// Writes the authoritative R2-scanned byte total back into the DB counter so
// the upload route's fast-path read stays accurate even if past increments drifted.
export async function syncStorageCounter(totalBytes: number) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  await supabase
    .from('user_secrets')
    .upsert({ user_id: user.id, storage_bytes: totalBytes }, { onConflict: 'user_id' })
}

// Lists every object under {userId}/ in R2, sums sizes, and groups by app.
// Paginates automatically — handles any number of objects.
export async function getStorageUsage(): Promise<StorageUsage | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const prefix = `${user.id}/`
  let token: string | undefined
  let totalBytes = 0
  const apps: Record<string, { bytes: number; count: number }> = {}

  try {
    do {
      const res = await getR2Client().send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }))
      for (const obj of res.Contents ?? []) {
        const size = obj.Size ?? 0
        totalBytes += size
        // Key: {userId}/{app}/... — extract the app segment
        const app = (obj.Key ?? '').slice(prefix.length).split('/')[0] || 'other'
        if (!apps[app]) apps[app] = { bytes: 0, count: 0 }
        apps[app].bytes += size
        apps[app].count += 1
      }
      token = res.NextContinuationToken
    } while (token)
  } catch {
    return null
  }

  return { totalBytes, apps }
}

// ── Library items ──────────────────────────────────────────────────────────────

export async function updateLibraryItem(
  id: string,
  updates: {
    summary?: string | null
    tags?: string[]
    verified?: boolean
    metadata?: Record<string, unknown>
  },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }

  const { data: existing } = await supabase
    .from('library_items')
    .select('id, version')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('deleted', false)
    .maybeSingle()
  if (!existing) return { ok: false, error: 'Item not found' }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    version: (existing.version ?? 1) + 1,
  }
  if (updates.summary !== undefined) patch.summary = updates.summary
  if (updates.tags !== undefined) patch.tags = updates.tags
  if (updates.verified !== undefined) patch.verified = updates.verified
  if (updates.metadata !== undefined) patch.metadata = updates.metadata

  const { error } = await supabase
    .from('library_items')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deleteLibraryItem(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated' }

  const { data: existing } = await supabase
    .from('library_items')
    .select('id, version')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('deleted', false)
    .maybeSingle()
  if (!existing) return { ok: false, error: 'Item not found' }

  const { error } = await supabase
    .from('library_items')
    .update({
      deleted: true,
      updated_at: new Date().toISOString(),
      version: (existing.version ?? 1) + 1,
    })
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
