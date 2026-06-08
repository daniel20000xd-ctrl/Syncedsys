// Claude.ai / MCP desktop falls back to {issuer}/token (root-level default) when
// it can't read token_endpoint from the discovery doc. Re-export the same handler
// so both /api/mcp/oauth/token and /token work.
export { POST, OPTIONS } from '@/app/api/mcp/oauth/token/route'
