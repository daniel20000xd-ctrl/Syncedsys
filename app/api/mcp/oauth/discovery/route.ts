// OAuth Authorization Server Metadata (RFC 8414).
// Served at /.well-known/oauth-authorization-server via next.config.ts rewrite.
// Claude.ai fetches this to discover the authorize + token endpoints.

// Derive the base URL from the request host so the advertised endpoints always
// match the domain the client is actually talking to. The apex domain
// 308-redirects to www; hardcoding either one makes the token POST hit a
// cross-origin redirect the OAuth client won't follow, breaking the exchange.
function baseFromReq(req: Request): string {
  let host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'www.syncedsys.com'
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  // The bare apex 308-redirects to www. Advertise the www endpoints so the
  // client's token-exchange POST never hits a redirect it won't follow.
  if (host === 'syncedsys.com') host = 'www.syncedsys.com'
  return `${proto}://${host}`
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
}

export function GET(req: Request) {
  const BASE = baseFromReq(req)
  return Response.json({
    issuer: BASE,
    authorization_endpoint: `${BASE}/api/mcp/oauth/authorize`,
    token_endpoint: `${BASE}/api/mcp/oauth/token`,
    registration_endpoint: `${BASE}/api/mcp/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  }, { headers: CORS_HEADERS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
