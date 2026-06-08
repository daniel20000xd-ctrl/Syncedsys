// Claude.ai / MCP desktop falls back to {issuer}/register (root-level default) when
// it can't read registration_endpoint from the discovery doc. Re-export the same
// handler so both /api/mcp/oauth/register and /register work.
export { POST, OPTIONS } from '@/app/api/mcp/oauth/register/route'
