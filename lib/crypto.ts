import crypto from 'crypto'

// AES-256-GCM encryption for secrets at rest (e.g. users' Anthropic API keys).
// The key comes from APP_ENCRYPTION_KEY — a 32-byte secret, base64-encoded.
// Stored payload format: base64(iv).base64(authTag).base64(ciphertext)

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY
  if (!raw) throw new Error('APP_ENCRYPTION_KEY is not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (base64-encoded)')
  return key
}

export function encryptSecret(plain: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.')
}

export function decryptSecret(payload: string): string {
  const key = getKey()
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload')
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// ── MCP personal access tokens ────────────────────────────────────────────────

// SHA-256 hex digest. Used to store only a hash of MCP tokens at rest, never the
// plaintext — the same one-way property as a password hash.
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// Opaque, URL-safe access token for connecting an external Claude client to the
// MCP. The `sk_ssys_` prefix makes it identifiable in logs and secret scanners.
export function randomToken(prefix = 'sk_ssys_'): string {
  return prefix + crypto.randomBytes(24).toString('base64url')
}

// Mint a short-lived Supabase-compatible user JWT (HS256, signed with the project
// JWT secret). Handed to a token-scoped Supabase client so RLS still resolves
// auth.uid() to this user — letting the unchanged server-actions layer run safely
// on behalf of a request authenticated by an MCP token instead of a cookie.
export function mintSupabaseUserJwt(userId: string, ttlSeconds = 600): string {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not set')
  const b64url = (v: string) => Buffer.from(v).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    sub: userId, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + ttlSeconds,
  }))
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
