// OAuth Protected Resource Metadata (RFC 9728 / MCP auth spec).
// Served at /api/mcp/.well-known/oauth-protected-resource via next.config.ts rewrite.
// Points MCP clients to the authorization server so they can discover the OAuth endpoints.

const BASE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://syncedsys.com').replace(/\/$/, '')

const CORS = { 'Access-Control-Allow-Origin': '*' }

export function GET() {
  return Response.json({
    resource: `${BASE}/api/mcp`,
    authorization_servers: [BASE],
  }, { headers: CORS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}
