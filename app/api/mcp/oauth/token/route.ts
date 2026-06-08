import { type NextRequest } from 'next/server'
import { consumeOAuthCode, verifyPkce, createPatForUser } from '@/lib/mcpOauth'

export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json',
}

function jsonErr(error: string, status = 400) {
  return Response.json({ error }, { status, headers: CORS })
}

// POST — exchange an authorization code + code_verifier for a PAT (sk_ssys_…).
// Body: application/x-www-form-urlencoded with:
//   grant_type=authorization_code, code, redirect_uri, code_verifier, [client_id]
export async function POST(req: NextRequest): Promise<Response> {
  const ct = req.headers.get('content-type') ?? ''
  let params: URLSearchParams

  if (ct.includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(await req.text())
  } else if (ct.includes('application/json')) {
    const body = await req.json() as Record<string, string>
    params = new URLSearchParams(body)
  } else {
    return jsonErr('unsupported_media_type', 415)
  }

  if (params.get('grant_type') !== 'authorization_code') {
    return jsonErr('unsupported_grant_type')
  }

  const code         = params.get('code') ?? ''
  const codeVerifier = params.get('code_verifier') ?? ''
  const clientId     = params.get('client_id') ?? 'claude'

  if (!code || !codeVerifier) {
    return jsonErr('invalid_request')
  }

  const record = await consumeOAuthCode(code)
  if (!record) {
    return jsonErr('invalid_grant', 400)
  }

  const valid = await verifyPkce(codeVerifier, record.codeChallenge)
  if (!valid) {
    return jsonErr('invalid_grant', 400)
  }

  try {
    const token = await createPatForUser(record.userId, `Claude (${clientId})`)
    // RFC 6749 §5.1: access_token + token_type required; expires_in RECOMMENDED
    // (Claude expects it). The sk_ssys_ PAT does not expire, so advertise a long
    // honest lifetime. no-store is mandated so intermediaries can't cache it.
    return Response.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 31536000,
    }, { headers: { ...CORS, 'Cache-Control': 'no-store', 'Pragma': 'no-cache' } })
  } catch (err) {
    console.error('OAuth token exchange failed:', err)
    return jsonErr('server_error', 500)
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}
