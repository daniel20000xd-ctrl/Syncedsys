// OAuth Authorization Server Metadata served at the canonical well-known path.
// This is the primary discovery endpoint — the rewrite in next.config.ts is
// a fallback. Having both ensures Claude.ai / MCP clients always find it.

export { GET, OPTIONS } from '@/app/api/mcp/oauth/discovery/route'
