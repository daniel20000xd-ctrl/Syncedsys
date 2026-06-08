// Claude.ai / MCP desktop constructs the authorization URL as {issuer}/authorize
// rather than reading authorization_endpoint from the discovery doc.
// Re-export the same handler so both paths work.
export { GET, POST } from '@/app/api/mcp/oauth/authorize/route'
