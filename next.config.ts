import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next 15+ defaults staleTimes.dynamic to 0, meaning every tab navigation
    // triggers a full server re-render even for pages you just visited.
    // Setting dynamic:30 means an already-visited board tab is served from the
    // client router cache instantly for 30 s, then revalidates in the background.
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },

  // MCP OAuth discovery endpoints. The well-known paths can't be served
  // directly from dotfolders in the App Router on all platforms, so we use
  // rewrites to route them to regular API route files.
  async rewrites() {
    return [
      {
        // OAuth Authorization Server Metadata (RFC 8414) — Claude.ai fetches
        // this from the domain root to discover the authorize + token endpoints.
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/mcp/oauth/discovery',
      },
      {
        // OAuth Protected Resource Metadata (RFC 9728 / MCP auth spec).
        // RFC 9728 §3.1 well-known path-insertion: for resource
        // https://host/api/mcp the metadata lives at
        // https://host/.well-known/oauth-protected-resource/api/mcp — this is
        // the canonical URL Claude probes (and the one the 401 header points to).
        source: '/.well-known/oauth-protected-resource/api/mcp',
        destination: '/api/mcp/oauth/resource',
      },
      {
        // Root-level fallback some clients probe when the resource has a path.
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/mcp/oauth/resource',
      },
      {
        // Legacy appended form (earlier MCP drafts) — kept for compatibility.
        source: '/api/mcp/.well-known/oauth-protected-resource',
        destination: '/api/mcp/oauth/resource',
      },
    ]
  },
};

export default nextConfig;
