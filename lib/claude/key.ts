import { decryptSecret } from '@/lib/crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type KeySource = 'user' | 'platform'

// Neither a user key nor a platform key is available — the request cannot run.
export class NoClaudeKeyError extends Error {
  constructor() {
    super('no_key')
    this.name = 'NoClaudeKeyError'
  }
}

// The user's stored key exists but could not be decrypted (e.g. APP_ENCRYPTION_KEY
// rotated). We surface this rather than silently billing them on the platform key.
export class KeyDecryptError extends Error {
  constructor() {
    super('decrypt_failed')
    this.name = 'KeyDecryptError'
  }
}

export type ResolvedKey = { apiKey: string; keySource: KeySource; writesEnabled: boolean }

// Resolve which Anthropic key a server-side request should run on:
//   1. the user's own stored key (keySource 'user') if present — they pay Anthropic
//      directly and are never billed by the platform;
//   2. otherwise the platform key from ANTHROPIC_API_KEY (keySource 'platform') —
//      the request is metered and billable to the user at the configured markup.
// Throws KeyDecryptError if the user's stored key is unreadable. Throws
// NoClaudeKeyError if neither a user key nor a platform key is available.
export async function resolveAnthropicKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<ResolvedKey> {
  const { data } = await supabase
    .from('user_secrets')
    .select('anthropic_key_encrypted, claude_auto_apply')
    .eq('user_id', userId)
    .maybeSingle()

  const writesEnabled = !!data?.claude_auto_apply

  if (data?.anthropic_key_encrypted) {
    let apiKey: string
    try {
      apiKey = decryptSecret(data.anthropic_key_encrypted)
    } catch {
      throw new KeyDecryptError()
    }
    return { apiKey, keySource: 'user', writesEnabled }
  }

  const platform = process.env.ANTHROPIC_API_KEY
  if (platform) return { apiKey: platform, keySource: 'platform', writesEnabled }

  throw new NoClaudeKeyError()
}

// Non-throwing variant for callers that prefer a soft failure (MCP tools that
// return a tool-error message rather than an HTTP status).
export async function tryResolveAnthropicKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ apiKey: string; keySource: KeySource } | null> {
  try {
    const { apiKey, keySource } = await resolveAnthropicKey(supabase, userId)
    return { apiKey, keySource }
  } catch {
    return null
  }
}
