import { createAdminClient } from '@/lib/supabase/admin'
import { randomToken, sha256Hex } from '@/lib/crypto'

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// PKCE S256: base64url(SHA-256(code_verifier)) must equal code_challenge.
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(codeVerifier)
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const computed = Buffer.from(hash).toString('base64url')
  return computed === codeChallenge
}

// Store a short-lived authorization code tied to the user + PKCE challenge.
export async function storeOAuthCode(params: {
  userId: string
  codeChallenge: string
  redirectUri: string
  clientId: string
}): Promise<string> {
  const code = randomToken('') // prefix-less 32-char base64url random token
  const admin = createAdminClient()
  const { error } = await admin.from('mcp_oauth_codes').insert({
    code,
    user_id: params.userId,
    code_challenge: params.codeChallenge,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  if (error) throw new Error('Failed to store OAuth code: ' + error.message)
  return code
}

// Consume a code (marks it used). Returns null if not found, expired, or already used.
export async function consumeOAuthCode(code: string): Promise<{
  userId: string
  codeChallenge: string
  redirectUri: string
} | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('mcp_oauth_codes')
    .select('user_id, code_challenge, redirect_uri')
    .eq('code', code)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (!data) return null
  await admin.from('mcp_oauth_codes').update({ used_at: new Date().toISOString() }).eq('code', code)
  return { userId: data.user_id, codeChallenge: data.code_challenge, redirectUri: data.redirect_uri }
}

// Create a PAT for the given user via the admin client (no browser session needed).
// The plaintext token is returned once and never stored.
export async function createPatForUser(userId: string, label: string): Promise<string> {
  const admin = createAdminClient()
  const token = randomToken() // sk_ssys_...
  const { error } = await admin.from('mcp_tokens').insert({
    user_id: userId,
    token_hash: sha256Hex(token),
    name: label,
  })
  if (error) throw new Error('Failed to create PAT: ' + error.message)
  return token
}
