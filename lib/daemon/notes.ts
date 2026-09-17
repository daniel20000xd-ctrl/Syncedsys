import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { recordWarning } from './usage'

export type OperatingNotes = { version: number; content: string; created_at: string }

// Latest row is current. Rows are never updated or deleted, so pruning a line from
// the current version never destroys it.
export async function getLatestNotes(userId: string): Promise<OperatingNotes | null> {
  const { data, error } = await createAdminClient()
    .from('daemon_operating_notes')
    .select('version, content, created_at')
    .eq('user_id', userId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`operating notes read failed: ${error.message}`)
  return data as OperatingNotes | null
}

// Newest first.
export async function getRecentNotes(userId: string, count: number): Promise<OperatingNotes[]> {
  const { data, error } = await createAdminClient()
    .from('daemon_operating_notes')
    .select('version, content, created_at')
    .eq('user_id', userId)
    .order('version', { ascending: false })
    .limit(count)
  if (error) throw new Error(`operating notes read failed: ${error.message}`)
  return (data ?? []) as OperatingNotes[]
}

export async function writeNotes(userId: string, content: string): Promise<number> {
  const admin = createAdminClient()
  const latest = await getLatestNotes(userId)
  const version = (latest?.version ?? 0) + 1
  const { error } = await admin.from('daemon_operating_notes').insert({ user_id: userId, version, content })
  if (error) throw new Error(`operating notes write failed: ${error.message}`)

  // Over the cap is stored anyway (truncating would destroy content); the warning row
  // makes the drift visible in the usage ledger.
  const max = daemonEnv.notesMaxChars()
  if (content.length > max) {
    await recordWarning(userId, 'reflection', `operating_notes v${version} is ${content.length} chars (cap ${max})`)
  }
  return version
}
