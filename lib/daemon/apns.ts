import http2 from 'http2'
import crypto from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

// Token-based (.p8, ES256 JWT) APNs over HTTP/2. Node runtime only.

export type ApnsEnvironment = 'sandbox' | 'production'
export type ApnsPayload = Record<string, unknown>

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

let cachedJwt: { token: string; issuedAt: number } | null = null

export function apnsConfigured(): boolean {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_BUNDLE_ID && process.env.APNS_PRIVATE_KEY)
}

// Apple rejects tokens older than an hour and throttles refreshing more than every
// 20 minutes, so reuse for 50.
function providerToken(): string {
  const now = Math.floor(Date.now() / 1000)
  if (cachedJwt && now - cachedJwt.issuedAt < 50 * 60) return cachedJwt.token
  const b64url = (v: object | Buffer) =>
    (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url')
  const header = b64url({ alg: 'ES256', kid: process.env.APNS_KEY_ID })
  const claims = b64url({ iss: process.env.APNS_TEAM_ID, iat: now })
  const pem = Buffer.from(process.env.APNS_PRIVATE_KEY!, 'base64').toString('utf8')
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: crypto.createPrivateKey(pem),
    dsaEncoding: 'ieee-p1363',
  })
  cachedJwt = { token: `${header}.${claims}.${b64url(signature)}`, issuedAt: now }
  return cachedJwt.token
}

type SendResult = { token: string; status: number; reason?: string }

function sendOne(session: http2.ClientHttp2Session, token: string, body: string): Promise<SendResult> {
  return new Promise(resolve => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': process.env.APNS_BUNDLE_ID!,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    })
    let status = 0
    let data = ''
    req.setTimeout(10_000, () => {
      req.close()
      resolve({ token, status: 0, reason: 'timeout' })
    })
    req.on('response', headers => { status = Number(headers[':status']) })
    req.setEncoding('utf8')
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      let reason: string | undefined
      try { reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined } catch { reason = data }
      resolve({ token, status, reason })
    })
    req.on('error', err => resolve({ token, status: 0, reason: err.message }))
    req.end(body)
  })
}

// Pushes to every registered token. Returns how many Apple accepted.
// Tokens Apple reports as unregistered (410) are pruned.
export async function pushToAll(userId: string, payload: ApnsPayload): Promise<number> {
  if (!apnsConfigured()) {
    console.warn('[daemon/apns] APNS_* env not set; skipping push')
    return 0
  }
  const admin = createAdminClient()
  const { data: rows, error } = await admin
    .from('daemon_push_tokens')
    .select('device_token, environment')
    .eq('user_id', userId)
  if (error) throw new Error(`push token read failed: ${error.message}`)
  if (!rows?.length) return 0

  const body = JSON.stringify(payload)
  const fallbackEnv: ApnsEnvironment = process.env.APNS_ENV === 'sandbox' ? 'sandbox' : 'production'
  const byEnv = new Map<ApnsEnvironment, string[]>()
  for (const r of rows) {
    const env: ApnsEnvironment = r.environment === 'sandbox' || r.environment === 'production' ? r.environment : fallbackEnv
    byEnv.set(env, [...(byEnv.get(env) ?? []), r.device_token])
  }

  let delivered = 0
  const dead: string[] = []
  for (const [env, tokens] of byEnv) {
    const session = http2.connect(HOSTS[env])
    session.on('error', e => console.error('[daemon/apns] session error:', e.message))
    try {
      const results = await Promise.all(tokens.map(t => sendOne(session, t, body)))
      for (const r of results) {
        if (r.status === 200) delivered++
        else if (r.status === 410) dead.push(r.token)
        else console.error(`[daemon/apns] ${env} push failed`, r.status, r.reason)
      }
    } finally {
      session.close()
    }
  }
  if (dead.length) await admin.from('daemon_push_tokens').delete().in('device_token', dead)
  return delivered
}
