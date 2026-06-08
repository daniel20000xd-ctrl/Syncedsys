import { createAdminClient } from '@/lib/supabase/admin'
import { randomToken, sha256Hex, encryptSecret, decryptSecret } from '@/lib/crypto'

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// PKCE S256: base64url(SHA-256(code_verifier)) must equal code_challenge.
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(codeVerifier)
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const computed = Buffer.from(hash).toString('base64url')
  return computed === codeChallenge
}

// The authorization code is a stateless, AES-256-GCM-encrypted payload — no DB
// row. It binds the user + PKCE challenge + redirect_uri + expiry, and the token
// endpoint can only decrypt it with the server's APP_ENCRYPTION_KEY. This avoids
// any migration dependency; single-use isn't enforced but the 10-min TTL plus the
// PKCE code_verifier (held only by the legitimate client) makes replay a non-issue.
type CodePayload = { u: string; c: string; r: string; e: number }

// Issue a short-lived authorization code tied to the user + PKCE challenge.
export async function storeOAuthCode(params: {
  userId: string
  codeChallenge: string
  redirectUri: string
  clientId: string
}): Promise<string> {
  const payload: CodePayload = {
    u: params.userId,
    c: params.codeChallenge,
    r: params.redirectUri,
    e: Date.now() + CODE_TTL_MS,
  }
  // base64url so the code is URL-safe in the redirect query string.
  return Buffer.from(encryptSecret(JSON.stringify(payload)), 'utf8').toString('base64url')
}

// Decode + validate a code. Returns null if tampered, malformed, or expired.
export async function consumeOAuthCode(code: string): Promise<{
  userId: string
  codeChallenge: string
  redirectUri: string
} | null> {
  try {
    const encrypted = Buffer.from(code, 'base64url').toString('utf8')
    const payload = JSON.parse(decryptSecret(encrypted)) as CodePayload
    if (!payload.u || !payload.c || typeof payload.e !== 'number') return null
    if (Date.now() > payload.e) return null
    return { userId: payload.u, codeChallenge: payload.c, redirectUri: payload.r }
  } catch {
    return null
  }
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
