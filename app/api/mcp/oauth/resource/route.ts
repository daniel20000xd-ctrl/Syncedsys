// OAuth Protected Resource Metadata (RFC 9728 / MCP auth spec).
// Served at /api/mcp/.well-known/oauth-protected-resource via next.config.ts rewrite.
// Points MCP clients to the authorization server so they can discover the OAuth endpoints.

// Derive the base URL from the request host (apex 308-redirects to www; a
// hardcoded host makes the client's token POST hit a redirect it won't follow).
function baseFromReq(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'www.syncedsys.com'
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  return `${proto}://${host}`
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
}

export function GET(req: Request) {
  const BASE = baseFromReq(req)
  return Response.json({
    resource: `${BASE}/api/mcp`,
    authorization_servers: [BASE],
  }, { headers: CORS_HEADERS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
