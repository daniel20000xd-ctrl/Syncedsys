import type { SupabaseClient } from '@supabase/supabase-js'

// Maps the logical entity type name to its Supabase table.
const ENTITY_TABLE: Record<string, string> = {
  board:   'boards',
  list:    'lists',
  card:    'cards',
  element: 'board_elements',
  edge:    'board_edges',
}

/**
 * Reads the current state of an entity row and writes it to `snapshots`
 * so an MCP write tool can be undone or diffed later.
 *
 * Call at the top of any MCP write tool, before mutating the entity.
 * Failures are swallowed — a logging error must never abort the tool.
 */
export async function snapshotBefore(
  supabase: SupabaseClient,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const table = ENTITY_TABLE[entityType]
  if (!table) return

  try {
    const { data } = await supabase.from(table).select('*').eq('id', entityId).maybeSingle()
    if (!data) return
    await supabase.from('snapshots').insert({ user_id: userId, entity_type: entityType, entity_id: entityId, data })
  } catch {
    // Logging failures are non-fatal.
  }
}

/**
 * Appends a row to `claude_actions` recording which MCP tool ran,
 * what parameters it received, and which entity IDs it affected.
 *
 * Call at the top of any MCP write tool (after snapshotBefore).
 * Failures are swallowed — a logging error must never abort the tool.
 */
export async function logAction(
  supabase: SupabaseClient,
  userId: string,
  tool: string,
  params: Record<string, unknown>,
  affectedIds: string[],
): Promise<void> {
  try {
    await supabase.from('claude_actions').insert({ user_id: userId, tool, params, affected_ids: affectedIds })
  } catch {
    // Logging failures are non-fatal.
  }
}
