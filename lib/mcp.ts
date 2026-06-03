import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Returns true if the user has an Anthropic API key stored in user_secrets.
 * Pass userId to filter explicitly; omit to rely on RLS (server components).
 */
export async function isClaudeEnabled(supabase: SupabaseClient, userId?: string): Promise<boolean> {
  const base = supabase.from('user_secrets').select('anthropic_key_encrypted')
  const { data } = await (userId ? base.eq('user_id', userId) : base).maybeSingle()
  return !!data?.anthropic_key_encrypted
}

const ENTITY_TABLE: Record<string, string> = {
  board:   'boards',
  list:    'lists',
  card:    'cards',
  element: 'board_elements',
  edge:    'board_edges',
}

/**
 * Reads the current state of an entity row and inserts it to snapshots.
 * Call before mutating the entity to enable undo/diff in future tooling.
 * Failures are swallowed — logging errors never abort the tool.
 */
export async function snapshotBefore(
  supabase: SupabaseClient,
  entityType: string,
  entityId: string,
  triggeredBy?: string,
): Promise<void> {
  const table = ENTITY_TABLE[entityType]
  if (!table) return

  try {
    const { data } = await supabase.from(table).select('*').eq('id', entityId).maybeSingle()
    if (!data) return
    await supabase.from('snapshots').insert({
      entity_type: entityType,
      entity_id: entityId,
      data,
      triggered_by: triggeredBy,
    })
  } catch {
    // Logging failures are non-fatal.
  }
}

/**
 * Logs a Claude action invocation to claude_actions table.
 * Failures are swallowed — logging errors never abort the tool.
 */
export async function logAction(
  supabase: SupabaseClient,
  tool: string,
  params: Record<string, unknown>,
  affectedIds: string[],
): Promise<void> {
  try {
    await supabase.from('claude_actions').insert({
      tool,
      params,
      affected_ids: affectedIds,
    })
  } catch {
    // Logging failures are non-fatal.
  }
}
