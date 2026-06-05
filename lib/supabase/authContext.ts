import { AsyncLocalStorage } from 'async_hooks'

// Request-scoped auth context. When set, `createClient()` builds a Supabase client
// scoped to this access token instead of reading cookies. The MCP route sets it
// after authenticating a personal access token, so every server action invoked
// during that request runs as the token's owner under RLS — no per-action change.
export const supabaseAuthContext = new AsyncLocalStorage<{ accessToken: string }>()
