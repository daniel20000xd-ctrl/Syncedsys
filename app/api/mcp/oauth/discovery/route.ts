// OAuth Authorization Server Metadata (RFC 8414).
// Served at /.well-known/oauth-authorization-server via next.config.ts rewrite.
// Claude.ai fetches this to discover the authorize + token endpoints.

const BASE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://syncedsys.com').replace(/\/$/, '')

const CORS = { 'Access-Control-Allow-Origin': '*' }

export function GET() {
  return Response.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/api/mcp/oauth/authorize`,
    token_endpoint: `${BASE}/api/mcp/oauth/token`,
    registration_endpoint: `${BASE}/api/mcp/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  }, { headers: CORS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}
