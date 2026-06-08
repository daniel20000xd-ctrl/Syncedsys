// Dynamic Client Registration (RFC 7591).
// Claude.ai posts here before starting the OAuth flow to obtain a client_id.
// For this single-user MCP we accept any registration — no persistent storage
// needed because the authorize/token endpoints already accept any client_id.

import { type NextRequest } from 'next/server'
import { randomUUID } from 'crypto'

export const dynamic = 'force-dynamic'

const CORS = { 'Access-Control-Allow-Origin': '*' }

export async function POST(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body is fine */ }

  const clientId = randomUUID()
  return Response.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris ?? [],
    grant_types: body.grant_types ?? ['authorization_code'],
    response_types: body.response_types ?? ['code'],
    token_endpoint_auth_method: 'none',
    client_name: body.client_name ?? 'Claude',
  }, { status: 201, headers: CORS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}
