import crypto from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

// Shared Google OAuth infrastructure for the whole Syncedsys ecosystem — every
// Google integration (Calendar, Sheets, Docs) authenticates through here.
//
// Tokens live in user_google_tokens, encrypted at rest with the same AES-256-GCM
// pattern used for Anthropic keys (lib/crypto). The userId-explicit functions
// (getAccessToken / revoke / hasGoogleAuth …) read and write via the service-role
// client so they work from any server context — a request, the OAuth callback, a
// cron job, or the MCP — independent of whose cookie session is current. RLS on
// the table still confines any direct client access to the owner's own row.

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

// Refresh slightly ahead of the real expiry so a token never lapses mid-request.
const EXPIRY_SKEW_MS = 60_000

// Standard OpenID identity scopes. Requested alongside the functional scopes so
// we can resolve the connected account's email/name (and so the /api/google/test
// verification endpoint works) — the functional scopes alone don't grant userinfo.
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile']

// Functional scopes the Syncedsys Google integrations need.
export const GOOGLE_INTEGRATION_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',
]

// Everything requested in the initial connect flow — one consent screen for all
// of it, so the user only authorizes Google once.
export const DEFAULT_GOOGLE_SCOPES = [...GOOGLE_IDENTITY_SCOPES, ...GOOGLE_INTEGRATION_SCOPES]

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID
  if (!v) throw new Error('GOOGLE_CLIENT_ID is not set')
  return v
}

function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET
  if (!v) throw new Error('GOOGLE_CLIENT_SECRET is not set')
  return v
}

function defaultRedirectUri(): string {
  const v = process.env.GOOGLE_REDIRECT_URI
  if (!v) throw new Error('GOOGLE_REDIRECT_URI is not set')
  return v
}

type GoogleTokenRow = {
  user_id: string
  access_token: string // encrypted
  refresh_token: string // encrypted
  scopes: string[]
  expires_at: string
}

// state carries the initiating userId across the OAuth round-trip so the callback
// can tie Google's response back to a user and reject mismatches (CSRF defence).
function encodeState(userId: string): string {
  const payload = JSON.stringify({ userId, nonce: crypto.randomBytes(8).toString('base64url') })
  return Buffer.from(payload).toString('base64url')
}

export function decodeState(state: string): { userId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
    return parsed && typeof parsed.userId === 'string' ? { userId: parsed.userId } : null
  } catch {
    return null
  }
}

async function readTokenRow(userId: string): Promise<GoogleTokenRow | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('user_google_tokens')
    .select('user_id, access_token, refresh_token, scopes, expires_at')
    .eq('user_id', userId)
    .maybeSingle()
  return (data as GoogleTokenRow | null) ?? null
}

// Build the Google OAuth consent URL. access_type=offline + prompt=consent
// guarantees a refresh token is returned every time.
export function getGoogleAuthUrl(userId: string, scopes: string[], redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri || defaultRedirectUri(),
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: encodeState(userId),
  })
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

// Exchange the auth code for access + refresh tokens and store them encrypted.
// Runs inside the OAuth callback, which carries the initiating user's session
// cookies — so the current Supabase user is the account that started the flow.
// userId is passed in by the callback route (which already called getUser for the
// CSRF state check) so we don't call getUser a second time and race on the same
// Supabase refresh token (would cause refresh_token_already_used).
export async function exchangeCodeForTokens(code: string, userId: string): Promise<void> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: defaultRedirectUri(),
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Google token exchange failed (${res.status}): ${detail}`)
  }

  const tok = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope?: string
  }

  // Google only returns a refresh token on first consent. prompt=consent makes it
  // return one each time, but never overwrite a good refresh token with null:
  // fall back to the stored one if this response somehow omits it.
  let refreshToken = tok.refresh_token
  if (!refreshToken) {
    const existing = await readTokenRow(userId)
    if (existing) refreshToken = decryptSecret(existing.refresh_token)
  }
  if (!refreshToken) throw new Error('Google did not return a refresh token')

  const scopes = tok.scope ? tok.scope.split(' ').filter(Boolean) : []
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString()

  const admin = createAdminClient()
  const { error } = await admin.from('user_google_tokens').upsert(
    {
      user_id: userId,
      access_token: encryptSecret(tok.access_token),
      refresh_token: encryptSecret(refreshToken),
      scopes,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (error) throw new Error(`Failed to store Google tokens: ${error.message}`)
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Google token refresh failed (${res.status}): ${detail}`)
  }

  const tok = (await res.json()) as {
    access_token: string
    expires_in: number
    refresh_token?: string
    scope?: string
  }

  const update: Record<string, unknown> = {
    access_token: encryptSecret(tok.access_token),
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }
  // Google rarely rotates the refresh token, but persist a new one if it sends it.
  if (tok.refresh_token) update.refresh_token = encryptSecret(tok.refresh_token)
  if (tok.scope) update.scopes = tok.scope.split(' ').filter(Boolean)

  const admin = createAdminClient()
  const { error } = await admin.from('user_google_tokens').update(update).eq('user_id', userId)
  if (error) throw new Error(`Failed to persist refreshed Google token: ${error.message}`)
  return tok.access_token
}

// Return a valid access token for the user, refreshing transparently if the
// stored one has expired (or is about to).
export async function getAccessToken(userId: string): Promise<string> {
  const row = await readTokenRow(userId)
  if (!row) throw new Error('No Google account connected for this user')

  const expiresAtMs = new Date(row.expires_at).getTime()
  if (Date.now() < expiresAtMs - EXPIRY_SKEW_MS) {
    return decryptSecret(row.access_token)
  }
  return refreshAccessToken(userId, decryptSecret(row.refresh_token))
}

// Force a refresh regardless of the stored expiry — used by googleFetch when a
// request 401s despite our expiry math (e.g. token revoked or clock skew).
export async function forceRefreshAccessToken(userId: string): Promise<string> {
  const row = await readTokenRow(userId)
  if (!row) throw new Error('No Google account connected for this user')
  return refreshAccessToken(userId, decryptSecret(row.refresh_token))
}

// Revoke the grant at Google and delete the stored tokens.
export async function revokeGoogleAccess(userId: string): Promise<void> {
  const row = await readTokenRow(userId)
  if (row) {
    // Revoking the refresh token invalidates the whole grant. Best-effort: a
    // revoke failure (already-revoked, network) must not block local cleanup.
    try {
      const token = decryptSecret(row.refresh_token)
      await fetch(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    } catch {}
  }
  const admin = createAdminClient()
  const { error } = await admin.from('user_google_tokens').delete().eq('user_id', userId)
  if (error) throw new Error(`Failed to remove Google tokens: ${error.message}`)
}

// Whether the user has a connected Google account (a stored refresh token).
export async function hasGoogleAuth(userId: string): Promise<boolean> {
  const row = await readTokenRow(userId)
  return !!row?.refresh_token
}

// The scopes currently authorized for the user's connected account.
export async function getGoogleScopes(userId: string): Promise<string[]> {
  const row = await readTokenRow(userId)
  return row?.scopes ?? []
}
