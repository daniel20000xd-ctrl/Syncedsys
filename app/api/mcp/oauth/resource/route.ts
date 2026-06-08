// OAuth Protected Resource Metadata (RFC 9728 / MCP auth spec).
// Served at /api/mcp/.well-known/oauth-protected-resource via next.config.ts rewrite.
// Points MCP clients to the authorization server so they can discover the OAuth endpoints.

const BASE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://syncedsys.com').replace(/\/$/, '')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
}

export function GET() {
  return Response.json({
    resource: `${BASE}/api/mcp`,
    authorization_servers: [BASE],
  }, { headers: CORS_HEADERS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
