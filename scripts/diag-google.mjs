import { readFileSync } from 'fs'

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const out = []
const need = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'APP_ENCRYPTION_KEY']
for (const k of need) out.push(`${k}: ${process.env[k] ? 'SET' : 'MISSING'}`)

try {
  const key = Buffer.from(process.env.APP_ENCRYPTION_KEY || '', 'base64')
  out.push(`APP_ENCRYPTION_KEY decoded bytes: ${key.length} ${key.length === 32 ? '(ok)' : '(BAD - must be 32)'}`)
} catch (e) { out.push('APP_ENCRYPTION_KEY decode error: ' + e.message) }

// PostgREST direct — avoids supabase-js realtime websocket init on Node 20
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const srk = process.env.SUPABASE_SERVICE_ROLE_KEY
const res = await fetch(`${url}/rest/v1/user_google_tokens?select=id&limit=0`, {
  headers: { apikey: srk, Authorization: `Bearer ${srk}`, Prefer: 'count=exact' },
})
const body = await res.text()
if (res.ok) {
  const range = res.headers.get('content-range') // e.g. "*/3"
  out.push(`TABLE user_google_tokens: EXISTS (content-range: ${range})`)
} else {
  out.push(`TABLE user_google_tokens: HTTP ${res.status} — ${body.slice(0, 300)}`)
}

console.log(out.join('\n'))
