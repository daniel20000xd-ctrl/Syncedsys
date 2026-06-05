import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { mintSupabaseUserJwt, sha256Hex } from '@/lib/crypto'

// Per-token fixed-window rate limit. Best-effort abuse protection backed by the
// token row itself, so it needs no external store (Redis/Upstash).
const RATE_LIMIT = 120        // requests
const RATE_WINDOW_MS = 60_000 // per minute

export type McpAuth =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; status: number; error: string }

// Resolve an MCP request to a Supabase user + an access token to scope it with.
//
// Two paths:
//  • Bearer sk_ssys_… personal access token (external Claude clients) — looked up
//    via the service role, rate-limited, then a short-lived user JWT is minted so
//    the request runs under RLS as the token owner. No Anthropic API key required.
//  • Cookie session (same-origin browser) — uses the live session access token.
export async function resolveMcpAuth(req: NextRequest): Promise<McpAuth> {
  const header = req.headers.get('authorization') ?? ''

  if (header.startsWith('Bearer sk_ssys_')) {
    const token = header.slice('Bearer '.length).trim()
    const admin = createAdminClient()

    const { data: row } = await admin
      .from('mcp_tokens')
      .select('id, user_id, window_start, request_count')
      .eq('token_hash', sha256Hex(token))
      .is('revoked_at', null)
      .maybeSingle()
    if (!row) return { ok: false, status: 401, error: 'Invalid or revoked MCP token.' }

    const now = Date.now()
    const windowStart = row.window_start ? new Date(row.window_start).getTime() : 0
    const withinWindow = now - windowStart <= RATE_WINDOW_MS
    const count = (withinWindow ? row.request_count ?? 0 : 0) + 1
    if (count > RATE_LIMIT) {
      return { ok: false, status: 429, error: 'Rate limit exceeded. Try again shortly.' }
    }
    await admin
      .from('mcp_tokens')
      .update({
        request_count: count,
        window_start: withinWindow ? row.window_start : new Date(now).toISOString(),
        last_used_at: new Date(now).toISOString(),
      })
      .eq('id', row.id)

    try {
      return { ok: true, userId: row.user_id, accessToken: mintSupabaseUserJwt(row.user_id) }
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : 'Token minting failed' }
    }
  }

  // Same-origin browser fallback: keep working off the live Supabase session.
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return { ok: false, status: 401, error: 'unauthorized' }
  return { ok: true, userId: session.user.id, accessToken: session.access_token }
}
