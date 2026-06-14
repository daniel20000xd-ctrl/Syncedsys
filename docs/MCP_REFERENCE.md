# Syncedsys MCP — Complete Reference

> Endpoint: `https://www.syncedsys.com/api/mcp` (MCP Streamable-HTTP, bearer-token auth)
> Generated from the live source in `app/api/mcp/route.ts` + `app/actions.ts`.

This document maps the full Syncedsys MCP surface: the connection/auth architecture
and every registered tool with its exact parameters, underlying behavior, side
effects, and gotchas.

---

# Connection & Auth Architecture

This document traces, end to end, how a request reaches the Syncedsys MCP server, how it authenticates, how Row-Level Security (RLS) is enforced so the request runs strictly as the token owner, the exact rate-limit numbers, what is logged/snapshotted on every write, and the precise security boundary of a personal access token.

Files covered:
- `A:\Projects\syncedsys\app\api\mcp\route.ts` — the MCP HTTP endpoint (`handle`, `buildServer`, `wrapWrite`, `ok`/`fail`/`wrap`, exported `GET`/`POST`/`DELETE`)
- `A:\Projects\syncedsys\lib\mcpAuth.ts` — `resolveMcpAuth` (bearer-token path vs cookie path, hash lookup, rate limiting)
- `A:\Projects\syncedsys\lib\crypto.ts` — `sha256Hex`, `randomToken`, `mintSupabaseUserJwt`, plus the AES-256-GCM secret helpers
- `A:\Projects\syncedsys\lib\supabase\authContext.ts` — the `AsyncLocalStorage` request-scoped auth context
- `A:\Projects\syncedsys\lib\supabase\server.ts` — how `createClient()` detects the injected JWT and scopes RLS
- `A:\Projects\syncedsys\lib\supabase\admin.ts` — the service-role `createAdminClient()`
- `A:\Projects\syncedsys\lib\supabase\middleware.ts` + `A:\Projects\syncedsys\proxy.ts` — the Next.js middleware and its `/api/` exemption
- `A:\Projects\syncedsys\lib\mcp.ts` — `snapshotBefore`, `logAction`

---

## 1. Request lifecycle at a glance

1. An HTTP request hits the Next.js middleware (`proxy.ts` → `updateSession`). For `/api/*` paths the middleware does **not** redirect to `/login`; it lets the request through so the API can authenticate itself and return JSON.
2. The request reaches `/api/mcp` (`route.ts`), where all three verbs (`GET`, `POST`, `DELETE`) are bound to the single `handle()` function.
3. `handle()` calls `resolveMcpAuth(req)` (`lib/mcpAuth.ts`), which returns either `{ ok: true, userId, accessToken }` or `{ ok: false, status, error }`.
4. On failure, `handle()` returns a JSON error body with the resolved status (401/429/500).
5. On success, `handle()` enters `supabaseAuthContext.run({ accessToken }, …)` — an `AsyncLocalStorage` scope — and inside it: creates a Supabase client (`createClient()`), builds the MCP server with `buildServer(supabase, userId)`, wires it to a `WebStandardStreamableHTTPServerTransport`, and delegates to `transport.handleRequest(req)`.
6. Every server action invoked during the exchange calls `createClient()`, which finds the injected access token in the ALS store and returns a client whose every query carries `Authorization: Bearer <jwt>` — so Postgres RLS resolves `auth.uid()` to the token owner.

---

## 2. The Next.js middleware and the `/api/` exemption

`proxy.ts` is the Next.js middleware entry. It delegates to `updateSession` (`lib/supabase/middleware.ts`) and uses this matcher:

```
matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)']
```

So `/api/mcp` **is** matched by the middleware (it is not excluded by the matcher). The exemption is inside `updateSession` itself. `updateSession` reads the cookie-based Supabase user (`supabase.auth.getUser()`), and if there is no user it normally redirects to `/login`. The redirect is suppressed for several path prefixes, including the newly added `/api/`:

```ts
if (
  !user &&
  !request.nextUrl.pathname.startsWith('/login') &&
  !request.nextUrl.pathname.startsWith('/signup') &&
  !request.nextUrl.pathname.startsWith('/auth/') &&
  // API routes authenticate themselves (bearer tokens for MCP/iOS sync/device
  // pairing, or their own cookie check) and must return JSON status codes — never
  // an HTML login redirect, which a cookieless API client cannot follow.
  !request.nextUrl.pathname.startsWith('/api/')
) {
  // redirect to /login
}
```

**Why this matters:** an external Claude client connecting to the MCP sends only a `Bearer sk_ssys_…` header and **no Supabase auth cookie**. Without the `/api/` exemption, the middleware would see "no user" and issue an HTML 307 redirect to `/login` — which a cookieless JSON/MCP client cannot follow, breaking the connection. The exemption lets the request fall through to the route handler, which performs its own bearer-token authentication and returns proper JSON status codes (401/429/500). The comment explicitly notes this also covers iOS sync and device pairing endpoints.

---

## 3. `resolveMcpAuth` — the two authentication paths (`lib/mcpAuth.ts`)

`resolveMcpAuth(req)` returns a discriminated union:

```ts
type McpAuth =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; status: number; error: string }
```

It reads the `Authorization` header and branches on whether it starts with `Bearer sk_ssys_`.

### Path A — Personal access token (external Claude clients)

Triggered when the header starts with `Bearer sk_ssys_`. Steps:

1. Strip the `Bearer ` prefix and trim to get the raw token.
2. Create a **service-role** admin client (`createAdminClient()` — uses `SUPABASE_SERVICE_ROLE_KEY`, bypasses RLS) so it can read the `mcp_tokens` table regardless of ownership.
3. Look up the token row by **hash**: `.eq('token_hash', sha256Hex(token))` and `.is('revoked_at', null)`, selecting `id, user_id, window_start, request_count`, via `.maybeSingle()`.
   - The plaintext token is never stored or queried — only its SHA-256 hex digest. A revoked token (`revoked_at` not null) is treated as nonexistent.
4. If no row matches → `{ ok: false, status: 401, error: 'Invalid or revoked MCP token.' }`.
5. **Rate limit** (fixed window, per token — see Section 4). If exceeded → `{ ok: false, status: 429, error: 'Rate limit exceeded. Try again shortly.' }`.
6. Update the token row in place: new `request_count`, possibly-reset `window_start`, and `last_used_at = now` (this also serves as a "last used" audit field).
7. **Mint a short-lived Supabase user JWT** for `row.user_id` via `mintSupabaseUserJwt(row.user_id)` and return `{ ok: true, userId: row.user_id, accessToken: <minted JWT> }`.
   - If minting throws (e.g. `SUPABASE_JWT_SECRET` missing) → `{ ok: false, status: 500, error: … }`.

Note: this path requires **no Anthropic API key** — auth is purely about identifying the token owner and scoping RLS. (An Anthropic key is only needed later by the AI tools like `find_relevant_boards` / `suggest_board_meta`.)

### Path B — Same-origin browser cookie session

When the header does not start with `Bearer sk_ssys_` (e.g. the app's own UI calling the MCP same-origin):

1. Build a normal cookie-scoped Supabase client (`createClient()` with no ALS injection → reads cookies).
2. `await supabase.auth.getSession()`. If there is no `session.user` → `{ ok: false, status: 401, error: 'unauthorized' }`.
3. Otherwise return `{ ok: true, userId: session.user.id, accessToken: session.access_token }` using the **live** Supabase session access token (not a minted one).

Both paths converge on the same shape: a `userId` and an `accessToken` that will be injected into the ALS context to scope RLS.

---

## 4. Rate limiting (exact numbers)

Defined as constants in `lib/mcpAuth.ts`:

```ts
const RATE_LIMIT = 120        // requests
const RATE_WINDOW_MS = 60_000 // per minute
```

- **Limit:** 120 requests per token per 60-second fixed window.
- **Scope:** per token row (keyed by the `mcp_tokens.id`), **not** per user — multiple tokens for the same user have independent budgets. Only Path A (bearer `sk_ssys_`) is rate-limited; the cookie path is not.
- **Algorithm (fixed window, stored on the token row — no Redis/external store):**
  - `windowStart = row.window_start` (ms) or `0` if null.
  - `withinWindow = (now - windowStart) <= 60_000`.
  - `count = (withinWindow ? row.request_count ?? 0 : 0) + 1` — if the previous window has expired, the counter resets to start counting from 1.
  - If `count > 120` → reject with **HTTP 429**.
  - Otherwise persist: `request_count = count`; `window_start` is left as-is when still within the window, or reset to `now` (ISO) when starting a fresh window; `last_used_at = now`.
- **Characteristics:** best-effort abuse protection. It is a fixed window (not sliding), so up to ~240 requests can occur across a window boundary in the worst case. The read-then-update is not atomic, so concurrent requests can race; this is acceptable for the stated "best-effort" purpose. It self-resets and needs no external infrastructure.

---

## 5. JWT minting (`mintSupabaseUserJwt` in `lib/crypto.ts`)

```ts
export function mintSupabaseUserJwt(userId: string, ttlSeconds = 600): string
```

- **Algorithm:** HS256, signed with `process.env.SUPABASE_JWT_SECRET` (throws if unset). This is the project's Supabase JWT secret, so the token is accepted by Supabase/PostgREST exactly like a real session token.
- **Header:** `{ alg: 'HS256', typ: 'JWT' }`.
- **Claims:**
  - `sub: userId` — drives `auth.uid()` under RLS.
  - `role: 'authenticated'`
  - `aud: 'authenticated'`
  - `iat: now` (seconds)
  - `exp: now + ttlSeconds` — **default TTL 600 seconds (10 minutes)**.
- Encoding is manual `base64url(header).base64url(payload).base64url(HMAC-SHA256(secret, header.payload))`.

This minted token is what makes the unchanged server-actions layer tenant-safe: a request authenticated by an opaque MCP token is converted into a short-lived, RLS-valid Supabase user JWT, so Postgres enforces the same policies it would for a logged-in browser session.

### Other `crypto.ts` helpers
- **`sha256Hex(input)`** — SHA-256 hex digest. Used to store/look up MCP tokens by hash only; the plaintext token is never persisted (same one-way property as a password hash).
- **`randomToken(prefix = 'sk_ssys_')`** — generates an opaque, URL-safe token: `sk_ssys_` + `base64url(24 random bytes)`. The `sk_ssys_` prefix makes the token recognizable in logs and secret scanners (this is what `resolveMcpAuth` keys off of and what gets hashed).
- **`encryptSecret` / `decryptSecret`** — AES-256-GCM for secrets at rest (e.g. users' Anthropic API keys), using a 32-byte base64 `APP_ENCRYPTION_KEY`. Stored as `base64(iv).base64(authTag).base64(ciphertext)`. (Not part of MCP auth, but the same module; relevant because `save_anthropic_key` relies on it.)

---

## 6. Request-scoped auth context (`lib/supabase/authContext.ts`)

```ts
export const supabaseAuthContext = new AsyncLocalStorage<{ accessToken: string }>()
```

A single `AsyncLocalStorage` instance holding `{ accessToken }`. When set, `createClient()` builds a token-scoped Supabase client instead of reading cookies. The MCP route sets it once after authentication, so every server action invoked during that request automatically runs as the token's owner under RLS — **with zero changes to the individual server actions**. This is the mechanism that lets `app/actions.ts` (written for cookie-based browser sessions) be reused verbatim for MCP requests.

---

## 7. How `createClient()` scopes RLS (`lib/supabase/server.ts`)

`createClient()` checks the ALS store first:

```ts
const injected = supabaseAuthContext.getStore()
if (injected?.accessToken) {
  return createSupabaseClient(URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${injected.accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
// else: cookie-based createServerClient(...)
```

- **Injected path (MCP):** uses the **anon key** as the apikey but attaches `Authorization: Bearer <minted JWT>` on every request. PostgREST validates the JWT against `SUPABASE_JWT_SECRET`, sets the role to `authenticated`, and `auth.uid()` resolves to the token owner's `sub`. **RLS is fully in force** — the request can only read/write rows the owner's policies allow. Session persistence and auto-refresh are disabled (it's a one-shot request-scoped client).
- **Cookie path (browser):** `createServerClient` from `@supabase/ssr` reads/writes cookies; in production cookies are scoped to `.syncedsys.com`, `sameSite: 'lax'`, `secure`.

Critically, the MCP client uses the **anon key, not the service role** — so even a bug in a server action cannot escalate beyond the token owner's RLS scope. Only `resolveMcpAuth` itself (and other admin operations) uses the service-role client, and only to read/update the `mcp_tokens` row by hash.

---

## 8. The route handler (`app/api/mcp/route.ts`)

### `handle(req)`
1. `const auth = await resolveMcpAuth(req)`.
2. If `!auth.ok`: return `new Response(JSON.stringify({ error: auth.error }), { status: auth.status, headers: { 'content-type': 'application/json' } })`.
3. Otherwise run everything inside `supabaseAuthContext.run({ accessToken: auth.accessToken }, async () => { … })`:
   - `const supabase = await createClient()` → token-scoped client (Section 7).
   - `const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` — Web-standard streamable HTTP transport from the MCP SDK; `sessionIdGenerator: undefined` means **stateless** (no server-side MCP session id; each request builds a fresh server/transport).
   - `const server = buildServer(supabase, auth.userId)` — constructs an `McpServer({ name: 'syncedsys', version: '1.0.0' })` with every tool registered, closing over this request's `supabase` and `userId`.
   - `await server.connect(transport)` then `return transport.handleRequest(req)`.

### Exported verbs
```ts
export const GET    = handle
export const POST   = handle
export const DELETE = handle
```
All three share one handler. `export const dynamic = 'force-dynamic'` forces per-request execution (no static caching), required because auth and ALS are per-request.

### Result helpers
- **`ok(data)`** — wraps a value into MCP content: if `data` is a string it is used directly, otherwise `JSON.stringify(data, null, 2)`; returns `{ content: [{ type: 'text', text }] }`.
- **`fail(msg)`** — returns `{ content: [{ type: 'text', text: msg }], isError: true }` (an MCP tool-level error, distinct from an HTTP error).
- **`wrap(fn)`** — `try { return ok(await fn() ?? { success: true }) } catch (e) { return fail(e.message) }`. Read-only tools use `wrap` directly; this is where a thrown server-action error (including RLS denials surfacing as errors) becomes a tool error message rather than crashing the transport.

---

## 9. `wrapWrite` — what happens on every write (`route.ts`) + logging/snapshotting (`lib/mcp.ts`)

Every mutating tool is registered through `wrapWrite`, defined inside `buildServer` so it closes over `supabase` and `userId`:

```ts
async function wrapWrite(tool, params, fn, snapshot?, affectedIds?) {
  if (!userId) return fail('Not authenticated')
  const ids = affectedIds ?? (snapshot?.entityId ? [snapshot.entityId] : [])
  await Promise.all([
    snapshot?.entityId
      ? snapshotBefore(supabase, snapshot.entityType, snapshot.entityId, userId, tool)
      : Promise.resolve(),
    logAction(supabase, tool, params, ids, userId),
  ])
  return wrap(fn)
}
```

Step by step on each write:
1. **Auth guard:** if `userId` is falsy → `fail('Not authenticated')` (defense in depth; auth already ran upstream).
2. **Determine affected ids:** explicit `affectedIds` if provided, else `[snapshot.entityId]` if a snapshot target exists, else `[]`.
3. **In parallel (`Promise.all`):**
   - **`snapshotBefore`** (only when a `snapshot.entityId` is given — i.e. for operations that mutate a pre-existing entity; create operations pass no snapshot): reads the current row and saves it for undo/diff. See below.
   - **`logAction`**: appends an audit record of the tool call. See below.
4. **Execute the actual mutation** via `wrap(fn)` — so a thrown error (including an RLS denial) returns a tool error, not a crash.

Notably the snapshot and log run **before** the mutation, and both are best-effort (their failures are swallowed and never block the write).

### `snapshotBefore(supabase, entityType, entityId, userId, triggeredBy)` (`lib/mcp.ts`)
- Maps `entityType → table` via `ENTITY_TABLE`: `board→boards`, `list→lists`, `card→cards`, `element→board_elements`, `edge→board_edges`. Unknown types are a no-op.
- Reads the full current row (`select('*')…maybeSingle()`); if none, returns.
- Inserts into the **`snapshots`** table: `{ entity_type, entity_id, data (the full prior row), triggered_by (the tool name), user_id }`.
- Wrapped in `try/catch` — failures are non-fatal. Because it runs on the token-scoped client, the snapshot insert is itself subject to RLS (writes the owner's `user_id`).
- Purpose: enables undo/diff in future tooling — the "before" image of any mutated board/list/card/element/edge.

### `logAction(supabase, tool, params, affectedIds, userId)` (`lib/mcp.ts`)
- Inserts into the **`claude_actions`** table: `{ tool, params, affected_ids, user_id }`.
- `params` is the sanitized argument object the tool passed (note: write tools deliberately log only metadata for bulky/sensitive fields — e.g. `update_board_content` logs only `{ boardId }` not the content; `save_anthropic_key` logs `{}` not the key; `reorder_cards` logs `{ boardId, count }`).
- Wrapped in `try/catch` — non-fatal. Also runs on the token-scoped client, so the row is owned by and visible only to the user under RLS.
- Purpose: an append-only audit trail of every write the MCP/Claude performed on the user's behalf.

**Read-only tools** (`get_boards_context`, `find_relevant_boards`, `get_board_content`, `get_board_readme`, `suggest_board_meta`, `get_pdf_url`, `get_claude_status`, `get_stocks_enabled`) bypass `wrapWrite` entirely — they neither snapshot nor log.

---

## 10. DB tables and side effects touched by the auth/connection layer

- **`mcp_tokens`** (service-role read + update in `resolveMcpAuth`): columns used include `id, user_id, token_hash, window_start, request_count, last_used_at, revoked_at`. Read by hash on every Path-A request; updated with the new counter/window/`last_used_at`. This is the only table the privileged (service-role) client touches during auth.
- **`snapshots`** (token-scoped insert per mutating write that targets an existing entity).
- **`claude_actions`** (token-scoped insert per write).
- All other tables (`boards`, `lists`, `cards`, `board_elements`, `board_edges`, `user_secrets`, etc.) are touched by the individual tool server actions, always through the token-scoped (anon-key + minted-JWT) client, i.e. under RLS.

No `revalidatePath` happens in the auth layer itself; cache revalidation lives inside the individual server actions in `app/actions.ts` (out of scope here).

---

## 11. The security boundary — what a token can and cannot reach

**A valid `sk_ssys_…` token can:**
- Act **only as its owning user** (`mcp_tokens.user_id`). Every Supabase query during the request carries a minted JWT whose `sub` is that user, so RLS confines all reads/writes to rows the owner is permitted to access.
- Invoke any registered MCP tool (full read + write surface over the owner's boards/lists/cards/elements/edges/devices/settings/account-links), subject to RLS and to the per-token rate limit.

**A token cannot:**
- **Reach another user's data.** It never gets the service-role client; it gets an anon-key client plus a user-scoped JWT, so RLS blocks cross-tenant access. The only service-role usage is the narrow, internal `mcp_tokens` lookup/update inside `resolveMcpAuth` — never exposed to tool code.
- **Outlive its window of trust at the DB layer.** The minted JWT has a **10-minute TTL** (`ttlSeconds = 600`); it is created fresh per request and never persisted (`persistSession: false`, `autoRefreshToken: false`).
- **Survive revocation.** Setting `revoked_at` makes the hash lookup (`.is('revoked_at', null)`) miss → immediate 401.
- **Be recovered from the database.** Only `sha256Hex(token)` is stored; the plaintext exists only client-side.
- **Exceed 120 requests/minute** per token (HTTP 429).
- **Bypass the audit trail.** Every write is logged to `claude_actions` and, for mutations of existing entities, snapshotted to `snapshots`, both attributed to the owner.

**Additional boundary notes / gotchas:**
- The whole model depends on three secrets: `SUPABASE_JWT_SECRET` (JWT minting — anyone with it could forge user JWTs), `SUPABASE_SERVICE_ROLE_KEY` (admin client — full RLS bypass), and `NEXT_PUBLIC_SUPABASE_ANON_KEY`/`URL`. Missing `SUPABASE_JWT_SECRET` yields a 500 on Path A.
- The transport is **stateless** (`sessionIdGenerator: undefined`): there is no long-lived MCP session; each HTTP request re-authenticates, re-mints a JWT, and rebuilds the server. This keeps auth fresh but means the rate-limit read-modify-write occurs once per request.
- The rate limiter is best-effort and racy (non-atomic read-then-update, fixed-window boundary bursts) — acceptable per its stated purpose, but not a hard guarantee.
- The cookie path (Path B) is **not** rate-limited and uses the live session token rather than a minted one; it exists so the same MCP endpoint keeps working for the same-origin browser UI.
- Logging/snapshotting are deliberately fault-tolerant: a failure to write `snapshots` or `claude_actions` never aborts the underlying mutation, so an audit-table outage degrades observability but not functionality.

---

Reference for the read-only / AI tools of the Syncedsys MCP server. Tool registrations live in `A:\Projects\syncedsys\app\api\mcp\route.ts`; underlying logic lives in `A:\Projects\syncedsys\app\actions.ts` and `A:\Projects\syncedsys\lib\claude\*`.

## Shared context (applies to all tools below)

- **Auth / user scoping.** The route handler (`handle`, route.ts:953) calls `resolveMcpAuth(req)` (`lib/mcpAuth.ts`). Two auth paths: a `Bearer sk_ssys_…` personal access token (looked up via the service role in `mcp_tokens` by `sha256Hex(token)`, rate-limited to 120 req/60s per token, then a short-lived user JWT is minted via `mintSupabaseUserJwt`), or a same-origin Supabase cookie session. Either way it yields `{ userId, accessToken }`. The whole MCP exchange then runs inside `supabaseAuthContext.run({ accessToken }, …)`, so every `createClient()` inside a server action is scoped to that user and **RLS applies**. `userId` passed into `buildServer` is the server-derived owner — never client input.
- **RLS is the real guard.** These read tools do their own `.eq('user_id', userId)` / `.eq('user_id', user.id)` filtering on top of RLS. `get_board_content`, `get_board_readme`, and `get_pdf_url` additionally do explicit ownership checks.
- **No `wrapWrite`.** None of these tools are write tools, so none call `snapshotBefore` / `logAction`, and none write to `mcp_action_log` / `mcp_snapshots`. The only DB writes any of them cause are append-only rows in the `claude_usage` ledger (the two Haiku-backed tools), written via the **service-role admin client** (see usage note below).
- **Return wrapping.** `ok(data)` wraps a result as MCP text content (`JSON.stringify` with 2-space indent unless already a string); `fail(msg)` returns `{ isError: true }` text; `wrap(fn)` runs `fn`, returns `ok(result ?? { success: true })`, and converts thrown errors to `fail(error.message)`.

---

### `get_boards_context`

**Purpose:** Returns every board for the authenticated user with name, mode, and AI description (`meta`).

**Parameters:** None. `inputSchema: undefined` (no arguments).

**What it does (route.ts:115–123):**
1. Calls `fetchBoards(supabase, userId)` (route.ts:59), which queries `boards` selecting `id,name,mode,meta`, filtered `.eq('user_id', userId)`, ordered by `tab_position` ascending.
2. On query error returns `fail('Failed to fetch boards.')`.
3. Otherwise formats via `formatBoards` into lines of the form `• [<mode>] <name> — <meta> (id: <id>)` (the `— <meta>` segment is omitted when `meta` is null). Empty list returns the string `'No boards found.'`.

**Returns:** A single plaintext block listing all boards (one bullet per board), wrapped by `ok`.

**Side effects:** None. Read-only `SELECT` on `boards`. No `revalidatePath`. No Anthropic key required.

**Gotchas:** Returns *all* boards including groups/sub-boards (no parent filtering) since it selects every row owned by the user. `meta` is the AI description field (max ~150 chars by convention). No pagination — returns the full set.

---

### `find_relevant_boards`  *(requires an Anthropic key)*

**Purpose:** Uses Claude Haiku to pick the 1–3 most relevant boards for a free-text query, matched against board name + description.

**Parameters:**
| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `query` | string | yes | — | What the user is looking for (`.describe('What the user is looking for')`). |

**What it does (route.ts:125–146):**
1. In parallel: `fetchBoards(supabase, userId)` and `tryResolveAnthropicKey(supabase, userId)`.
2. If boards query failed → `fail('Failed to fetch boards.')`.
3. If no resolved key → `fail('No Anthropic API key. Add one in Settings.')`.
4. Runs the **claudeGate** (`lib/claude/gate.ts`) with `resolved.keySource`. If gate fails: `claude_disabled` → `fail('Claude is temporarily unavailable.')`; otherwise (`free_tier_exhausted`) → `fail('Free Claude credit for this month is used up — add your own API key or enable pay-per-use in Settings.')`.
5. If the user has zero boards → returns `ok([])` (no Claude call).
6. Builds a TSV list (`id\tname\tmeta`) of all boards and calls Anthropic `messages.create` with model `claude-haiku-4-5-20251001` (`HAIKU_MODEL`), `max_tokens: 256`, prompting Claude to reply ONLY with a JSON array of board IDs.
7. Records usage via `recordClaudeUsage({ userId, model: HAIKU_MODEL, keySource, usage })`.
8. Parses the JSON array (defensive `try/catch`; on parse failure `ids = []`), then returns the matching boards filtered to `{ id, name, meta }`.

**Returns:** `ok` of a JSON array of `{ id, name, meta }` objects for the boards whose IDs Claude selected (possibly empty).

**Side effects:** Read `SELECT` on `boards`; read on `user_secrets` (key + auto-apply) and, on the platform-key path, `app_config` + `claude_usage` (via the gate). On a real Claude call, appends one row to **`claude_usage`** (service-role write, append-only; see usage note). No `revalidatePath`.

**Key gating (claudeGate / tryResolveAnthropicKey):**
- `tryResolveAnthropicKey` (non-throwing) resolves the key: a decrypted **user** key from `user_secrets.anthropic_key_encrypted` if present (`keySource: 'user'`, user pays Anthropic directly), else the **platform** key from `process.env.ANTHROPIC_API_KEY` (`keySource: 'platform'`, metered/billable). Returns `null` if neither exists or if the stored user key fails to decrypt — surfacing as the "No Anthropic API key" failure.
- `claudeGate` only gates **platform-key** requests (`keySource !== 'platform'` returns `{ ok: true }` immediately — own-key requests are never capped). For platform key: (a) kill switch — `process.env.CLAUDE_API_ENABLED === 'false'` or `app_config` row `key='claude_api'` with `enabled === false` → `claude_disabled`; (b) if `user_secrets.claude_pay_per_use` is true → uncapped; (c) otherwise sums this period's billable `claude_usage.cost_usd` (rows `.eq('billable', true).gte('created_at', currentPeriodStartIso())`) and blocks with `free_tier_exhausted` once `spent >= freeAllowanceUsd()` (default `$0.50`, `CLAUDE_FREE_ALLOWANCE_USD`; period = calendar month UTC).
- The free cap is a documented **soft cap** (checked before each request, so spend can overshoot by ~one request; Haiku paths are tiny). Non-opted-in users are never actually charged.

---

### `get_board_content`

**Purpose:** Returns the full content of one board — a README pointer, lists, cards, text content, and canvas elements — as a formatted text dump.

**Parameters:**
| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `board_id` | string | yes | — | Board ID (`.describe('Board ID')`). |

**What it does (route.ts:148–206):**
1. Loads the board: `boards` select `id,name,mode,meta,content,deadline,readme_md`, filtered `.eq('id', board_id).eq('user_id', userId).maybeSingle()`. If not found / not owned → `fail('Board not found or access denied.')` (explicit ownership check, redundant with RLS).
2. Loads `lists` (`id,name,position,deadline,hidden`) for the board, ordered by `position`.
3. In parallel: loads `cards` (`id,list_id,title,description,done,done_at,deadline,position`) for those list IDs ordered by `position` (skipped with empty data when there are no lists), and `board_elements` (`id,type,data,deadline`) for the board.
4. Groups cards by `list_id` and renders a Markdown-ish text report:
   - Header line: `Board: "<name>" [mode=<mode>, id=<id>]`; optional `Description:` (meta) and `Deadline:` lines.
   - README pointer (rendered before `## Lists`): a `README: yes|none` line; when present, a `README preview:` line (first line of `readme_md`, stripped of leading `#`, capped ~120 chars) and the notice `This board has operating instructions. Call get_board_readme(board_id) and follow them before acting on this board.`. The **full** readme text is not included here — fetch it via `get_board_readme`.
   - `## Lists` section: each list as `### <name> (due …)` plus `[hidden]` flag; each card prefixed `✓`/`·` with title, optional `[due YYYY-MM-DD]`, and `(done YYYY-MM-DD)`; card description indented on the next line; empty lists show `(empty)`.
   - If `mode === 'text'` and `content` is non-empty: a `## Content` section with `board.content` **truncated to 3000 chars**.
   - `## Canvas elements` section: one line per `board_elements` row, `[<id>] <label>`, with a type-specific label. Notably `text` is sliced to 200 chars, `pdf` includes name, page count, and inline extracted text **sliced to 2000 chars**, `portal` shows `viewerKind` or `targetBoardId`, `folderlink` shows name + target. Optional `[due …]`.

**Returns:** `ok` of a single multi-line string (the rendered report).

**Side effects:** None — read-only `SELECT`s on `boards`, `lists`, `cards`, `board_elements`. No `revalidatePath`. No Anthropic key required.

**Gotchas / caveats:** Output is lossy by design — board `content` capped at 3000 chars, element `text` at 200, PDF inline text at 2000. PDF *binary* is not returned here (use `get_pdf_url` for the file). Truncation means very long boards won't round-trip fully through this tool.

---

### `get_board_readme`

**Purpose:** Read **only** a board's README / operating instructions (the `readme_md` field) — no lists, cards, or canvas elements. A cheap alternative to `get_board_content` for boards that carry their own operating instructions an agent should read first.

**Parameters:**
| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `board_id` | string | yes | — | Board ID (`.describe('Board ID')`). |

**What it does:**
1. Loads the board: `boards` select `id,name,readme_md`, filtered `.eq('id', board_id).eq('user_id', userId).maybeSingle()`. If not found / not owned → `fail('Board not found or access denied.')` (same ownership check as `get_board_content`).
2. Computes `readme = (readme_md ?? '').trim()`.

**Returns:** `ok` of a JSON object `{ boardId, boardName, hasReadme, readme }`. Empty/missing readme → `hasReadme: false`, `readme: ""`.

**Side effects:** None — a single read-only `SELECT` on `boards` (no lists/cards/elements). No `revalidatePath`. No Anthropic key required.

**Note:** `readme_md` is the same field the in-app README box and `update_board_readme` write — distinct from `content` (board body / database config), which `update_board_content` writes.

---

### `suggest_board_meta`  *(requires an Anthropic key)*

**Purpose:** Generates a short (1–2 sentence) AI description for a board from its name and mode, to populate the `meta` field.

**Parameters:**
| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `name` | string | yes | — | Board name (`.describe('Board name')`). |
| `mode` | string | yes | — | Board mode (`.describe('Board mode')`). Note: a free-form `z.string()`, not the `BOARD_MODE` enum. |

**What it does (route.ts:208–223):**
1. `tryResolveAnthropicKey(supabase, userId)`; if `null` → `fail('No Anthropic API key. Add one in Settings.')`.
2. `claudeGate(supabase, userId, resolved.keySource)`; on failure same two messages as `find_relevant_boards` (`Claude is temporarily unavailable.` / `Free Claude credit … used up …`).
3. Calls the exported `suggestBoardMeta(name, mode, apiKey)` helper (route.ts:69–85): Anthropic `messages.create` with model `claude-haiku-4-5-20251001`, `max_tokens: 80`, prompting for a 1–2 sentence description with no quotes. The returned text is trimmed and **truncated to 150 chars**.
4. Records usage via `recordClaudeUsage({ userId, model: HAIKU_MODEL, keySource, usage })`.
5. Returns `ok(suggestion)` (the description string only — it does **not** persist `meta`; saving is the caller's job via `update_board`).

**Returns:** `ok` of the suggestion string (≤150 chars).

**Side effects:** Reads `user_secrets` (and `app_config` + `claude_usage` on the platform path, via the gate). Appends one row to **`claude_usage`** on a successful Claude call (service-role, append-only). Does **not** write the board — no `boards` update, no `revalidatePath`.

**Key gating:** Identical mechanism to `find_relevant_boards` — `tryResolveAnthropicKey` selects user vs platform key; `claudeGate` enforces the kill switch + free-tier cap only on the platform key. See the `find_relevant_boards` gating section above for full detail.

---

### `get_pdf_url`

**Purpose:** Mints a short-lived (1-hour) presigned URL for a stored PDF object so it can be opened in a browser tab.

**Parameters:**
| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `path` | string | yes | — | Storage path (object key) of the PDF, taken from a PDF element's `data.storagePath` (`.describe('Storage path of the PDF (from element data.storagePath)')`). |

**Wiring:** `({ path }) => wrap(() => getPdfUrl(path))` (route.ts:836–840) — note it is wrapped with `wrap`, not `wrapWrite`, so no logging/snapshot.

**What the action does (`getPdfUrl`, actions.ts:720–735):**
1. `createClient()` then `supabase.auth.getUser()`; if no user → `{ ok: false, error: 'Not authenticated' }`.
2. **Ownership enforcement:** if the key does **not** start with `<user.id>/` → `{ ok: false, error: 'Access denied.' }`. (Object keys are namespaced by user ID, so a user can only sign their own objects.)
3. Builds a `GetObjectCommand` against the R2 bucket (`R2_BUCKET`, env `R2_BUCKET_NAME`, default `'syncedsys-storage'`) using the R2 S3 client (`getR2Client()` — Cloudflare R2 endpoint from `CF_ACCOUNT_ID`, creds `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`) and signs it with `getSignedUrl(..., { expiresIn: 3600 })` (1 hour).
4. On success → `{ ok: true, url }`; on any throw → `{ ok: false, error: 'Could not open PDF.' }`.

**Returns:** `ok` of `{ ok: boolean; url?: string; error?: string }`.

**Side effects:** None on the database — this is a read/sign operation against Cloudflare R2 object storage (no Supabase tables touched beyond `auth.getUser()`). No `revalidatePath`. No Anthropic key required.

**Gotchas:** The URL expires in 1 hour. The argument is the raw R2 object key (must be prefixed with the caller's user ID), not a Supabase row ID — passing an element ID or a wrong path yields "Access denied." or "Could not open PDF.". A sibling action `getPresignedReadUrl` (actions.ts:739) does the same for arbitrary objects but is not exposed as an MCP tool.

---

## Anthropic-key requirement summary

| Tool | Needs Anthropic key? | Gated by claudeGate? |
|------|----------------------|----------------------|
| `get_boards_context` | No | No |
| `find_relevant_boards` | **Yes** (Haiku) | **Yes** (platform key only) |
| `get_board_content` | No | No |
| `get_board_readme` | No | No |
| `suggest_board_meta` | **Yes** (Haiku) | **Yes** (platform key only) |
| `get_pdf_url` | No | No |

**`claude_usage` ledger note (both AI tools):** `recordClaudeUsage` (`lib/claude/usage.ts`) writes append-only via the **service-role admin client** (`createAdminClient`), never the user-scoped client — RLS makes the ledger read-only for end users so a billed user cannot fabricate/edit/delete their own usage. `user_id` is the server-derived owner. Rows are `billable` only when `keySource === 'platform'`; user-key rows store `cost_usd: 0`. Writes are best-effort (all failures swallowed) so metering can never break a tool call. If usage is zero across all four token buckets, no row is written.

---

# Board Tools

These 15 MCP tools manage the `boards` table and its descendant entities for the authenticated Syncedsys user. They are registered in `A:\Projects\syncedsys\app\api\mcp\route.ts` and delegate to server actions in `A:\Projects\syncedsys\app\actions.ts`.

## Cross-cutting behavior (applies to every tool below)

- **Registration wrapper:** Every board tool is a *write* tool, so it is wrapped by the local `wrapWrite(tool, params, fn, snapshot?, affectedIds?)` helper in `route.ts` (lines 95-111). For each call `wrapWrite`:
  1. Returns `"Not authenticated"` immediately if `userId` is falsy.
  2. Computes `affectedIds` = the explicitly-passed array, else `[snapshot.entityId]` if a snapshot was supplied, else `[]`.
  3. Runs `snapshotBefore` (only if a `snapshot` arg with an `entityId` was passed) and `logAction` **in parallel** before executing the action.
  4. Executes the underlying action through `wrap()`, which returns the action's result (or `{ success: true }` when the action returns `undefined`/void) as JSON text, or an `isError` text payload on a thrown error.
- **`snapshotBefore` side effect** (`lib/mcp.ts`): reads the current row of the entity (`board` → `boards` table) and inserts a copy into the `snapshots` table (`entity_type`, `entity_id`, `data`, `triggered_by`=tool name, `user_id`). Failures are swallowed (non-fatal). For board tools the snapshotted entity is always a board row (or for `copy_board_into` the *source* board, for `ensure_mirror_portal` the *target* board, for `import_folder_tree` the *parent* board).
- **`logAction` side effect** (`lib/mcp.ts`): inserts a row into `claude_actions` (`tool`, `params`, `affected_ids`, `user_id`). Failures swallowed. Note the `params` recorded are exactly what `route.ts` passes — sometimes a *subset* of the real arguments (e.g. `update_board_content` logs `boardId` but **not** the `content`; `import_folder_tree` logs `parentBoardId`+`color` but not the `tree`).
- **Auth / RLS / scope** (`route.ts` `handle`, `lib/mcpAuth.ts`): The whole MCP exchange runs inside `supabaseAuthContext.run({ accessToken })`, so every action's `createClient()` is scoped to the calling user and Supabase RLS applies. Two auth paths: a `Bearer sk_ssys_…` personal access token (looked up via service role, rate-limited to 120 req/min/token, then a short-lived user JWT is minted) or a same-origin cookie session. In addition, **every board action independently re-fetches `auth.getUser()` and filters writes by `.eq('user_id', user.id)`** — so a user can only ever mutate their own boards, belt-and-suspenders on top of RLS.
- **Auto-apply gotcha:** These board write tools do **not** themselves check the `claude_auto_apply` flag — that gate is enforced elsewhere (e.g. the in-app Claude agent / settings layer). An MCP client with a valid token can call these regardless of the auto-apply toggle.
- **`revalidatePath` caveat:** Most board mutations call `revalidatePath('/', 'layout')` (full app re-render) and/or `revalidatePath('/board/{id}')`. A few deliberately omit revalidation (`update_board_free_position`, `update_board_content`, `layout_board_grid`) because the client holds the source of truth and applies the change optimistically — calling these from an external client will **not** trigger a server-side cache refresh, so other open sessions won't see the change until their next natural refetch.
- **No localStorage involvement:** None of these server actions touch localStorage; the "hidden map" / local caches mentioned in project memory live entirely client-side and are out of scope for these tools.

---

### create_board

**Purpose:** Create a new top-level board tab.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `name` | string | yes | — | Board name. |
| `color` | string | yes | — | Hex color, e.g. `#0079bf`. |
| `mode` | enum `classic`\|`trello`\|`text`\|`folder` | no | `classic` (applied inside the action) | Board mode. |

**Underlying action** `createBoard(name, color, mode='classic')` (actions.ts:307):
1. Requires an authenticated user (throws `Not authenticated` otherwise).
2. Queries the user's existing **top-level** boards (`parent_id IS NULL AND group_id IS NULL`), takes the max `tab_position`, and sets the new board's `tab_position` to `max+1` (or `0` if none).
3. Inserts into `boards` with `{ name, color, user_id, tab_position, mode }`. `parent_id`/`group_id` default null → it's a root tab.
4. `revalidatePath('/', 'layout')`.

**Returns:** the full inserted board row.
**Side effects:** inserts one `boards` row; `revalidatePath('/', 'layout')`; plus `logAction` (no snapshot — it's a create, no `snapshot` arg passed, so `affectedIds=[]`).

---

### create_group

**Purpose:** Create a group container (a special board with `is_group=true`) in the tab bar.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `name` | string | yes | — | Group name. |
| `color` | string | yes | — | Hex color. |
| `mode` | enum `folder`\|`classic` | yes | — | Group mode (narrower than board mode). |
| `parentGroupId` | string \| null | no | `null` | Parent group ID for a nested group, or null for a top-level group. |

**Underlying action** `createGroup(name, color, mode, parentGroupId=null)` (actions.ts:333):
1. Requires auth.
2. **Two-level nesting guard:** if `parentGroupId` is given, fetches that parent's `group_id`; if the parent is itself already nested (`group_id` set) it throws `Groups can only be nested two levels deep`.
3. Computes `tab_position` = max+1 among siblings (`parent_id IS NULL`, and either `group_id = parentGroupId` or `group_id IS NULL` for top-level).
4. Inserts into `boards` with `{ name, color, user_id, is_group:true, mode, group_id:parentGroupId, tab_position }`.
5. `revalidatePath('/', 'layout')`.

**Returns:** the inserted group (board) row.
**Side effects:** inserts one `boards` row (a group); `revalidatePath('/', 'layout')`. `wrapWrite` snapshots **only if `parentGroupId` is truthy** (snapshots the parent group board); `affectedIds` defaults to `[parentGroupId]` in that case, else `[]`.
**Gotcha:** Groups are "soft" containers — deleting a group nulls members' `group_id` rather than deleting them (per the action's doc comment). Membership is via `group_id`, distinct from the `parent_id` parent/child board hierarchy.

---

### move_tab

**Purpose:** Move a tab (board or group) into a group (or to top level) and reorder it.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | The tab being moved. |
| `newGroupId` | string \| null | yes (nullable) | — | Target group ID, or `null` for top-level. |
| `beforeBoardId` | string \| null | yes (nullable) | — | Insert before this sibling ID, or `null` to append to the end. |

**Underlying action** `moveTab(boardId, newGroupId, beforeBoardId)` (actions.ts:359):
1. Requires auth. No-ops if `boardId === newGroupId`.
2. **Group-into-group guard:** if the moving tab is itself a group (`is_group`) and `newGroupId` is set, the target must be a group (`Can only group into a group`) and must not itself be nested (`Groups can only be nested two levels deep`).
3. Updates the moving board: `{ group_id: newGroupId, parent_id: null }` (moving into a group forcibly clears any parent-board relationship).
4. Fetches all siblings in the destination container (top-level, matching `group_id`), ordered by `tab_position` then `created_at`, removes the moving board, splices it in at the index of `beforeBoardId` (or end if not found/null), then **rewrites every sibling's `tab_position` to its new index** via parallel updates.
5. `revalidatePath('/', 'layout')`.

**Returns:** void → tool reports `{ success: true }`.
**Side effects:** updates the moved board plus reindexes all destination siblings in `boards`; `revalidatePath('/', 'layout')`. Snapshots the moved board (`entityId=boardId`), `affectedIds=[boardId]`.

---

### update_board_free_position

**Purpose:** Set the free-canvas (x,y) position of a board (used in group-folder free mode).

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board to reposition. |
| `x` | number | yes | — | Canvas X (stored as `free_x`). |
| `y` | number | yes | — | Canvas Y (stored as `free_y`). |

**Underlying action** `updateBoardFreePosition(boardId, x, y)` (actions.ts:386):
1. Requires auth.
2. Updates `boards` row → `{ free_x: x, free_y: y }`, scoped by `id` and `user_id`.
3. **No `revalidatePath`.**

**Returns:** void → `{ success: true }`.
**Side effects:** updates `free_x`/`free_y` on one `boards` row. No revalidation (client owns position state). Snapshots the board; `affectedIds=[boardId]`.

---

### update_board_content

**Purpose:** Overwrite the free-text `content` of a board (relevant for `text`-mode boards).

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board to update. |
| `content` | string | yes | — | New full text content (overwrites, not appends). |

**Underlying action** `updateBoardContent(boardId, content)` (actions.ts:393):
1. Requires auth.
2. Updates `boards` → `{ content }`, scoped by `id`+`user_id`.
3. **No `revalidatePath`.**

**Returns:** void → `{ success: true }`.
**Side effects:** overwrites `content` on one `boards` row; no revalidation. Snapshots the board; `affectedIds=[boardId]`.
**Logging gotcha:** `route.ts` logs only `{ boardId }` to `claude_actions` — the actual `content` is intentionally **not** recorded in the action log.

---

### update_board_readme

**Purpose:** Write/replace a board's README / operating instructions — the `readme_md` field surfaced by the in-app README box and read back by `get_board_readme` (write/read are symmetric). Distinct from `update_board_content`, which writes the board **body** (`content`: text/canvas bodies, database config). Whole-document overwrite; editing is read-modify-write by the caller.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `board_id` | string | yes | — | Board to update (`.describe('Board ID')`; snake_case to match `get_board_readme`). |
| `readme` | string | yes | — | Full README markdown; overwrites the whole readme (empty string clears it). |

**Underlying action** `updateBoardReadme(boardId, readme)` (actions.ts):
1. Requires auth.
2. Updates `boards` → `{ readme_md: readme }`, scoped by `id`+`user_id`, with `.select('id,name').single()`. Zero rows (missing/unowned board) → throws `Board not found or access denied.`
3. **No `revalidatePath`** (mirrors `updateBoardContent`).

**Returns:** `ok` of `{ boardId, boardName, updated: true, readme }` (output keys camelCase, mirroring `get_board_readme`).
**Side effects:** overwrites `readme_md` on one `boards` row (**never** `content`); no revalidation. Snapshots the board; `affectedIds=[board_id]`.
**Logging gotcha:** `route.ts` logs only `{ board_id }` to `claude_actions` — the actual `readme` text is intentionally **not** recorded in the action log.

---

### create_sub_tab

**Purpose:** Create a child board nested under a parent board.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `parentBoardId` | string | yes | — | Parent board to nest under. |
| `name` | string | yes | — | Child board name. |
| `color` | string | yes | — | Hex color. |
| `mode` | enum `classic`\|`trello`\|`text`\|`folder` | no | `classic` | Child board mode. |

**Underlying action** `createSubTab(parentBoardId, name, color, mode='classic')` (actions.ts:400):
1. Requires auth.
2. `tab_position` = max+1 among existing children of `parentBoardId` (or `0`).
3. Inserts into `boards` with `{ name, color, user_id, parent_id: parentBoardId, tab_position, mode }`.
4. `revalidatePath('/', 'layout')`.

**Returns:** the inserted child board row.
**Side effects:** inserts one `boards` row with `parent_id` set; `revalidatePath('/', 'layout')`. Snapshots the **parent** board; `affectedIds=[parentBoardId]`.

---

### delete_board

**Purpose:** Permanently delete a board and its entire subtree (children, lists, cards, elements, edges) plus associated R2 storage objects.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Root board of the subtree to delete. |

**Underlying action** `deleteBoard(boardId)` (actions.ts:425):
1. Requires auth.
2. **BFS subtree collection:** starting from `boardId`, repeatedly queries `boards` by `parent_id IN (batch)` to gather every descendant board ID into `allBoardIds`.
3. Selects all `board_elements.data` across `allBoardIds`, and filters those with a `storagePath` (R2-backed files/PDFs, regardless of element type).
4. For those: batch-deletes the R2 objects via `DeleteObjectsCommand` (chunked at 1000 keys per call) — failures are swallowed in a try/catch. Then, if `totalBytes > 0`, decrements the user's `user_secrets.storage_bytes` by the summed `sizeBytes` (clamped at 0) via upsert.
5. Deletes the root board: `boards.delete().eq('id', boardId).eq('user_id', user.id)`. Descendant boards/lists/cards/elements/edges are removed by the DB's cascade (the action only explicitly deletes the root row).
6. `revalidatePath('/', 'layout')`.

**Returns:** void → `{ success: true }`.
**Side effects:** deletes one `boards` row (DB cascade removes the rest of the subtree across `boards`/`lists`/`cards`/`board_elements`/`board_edges`); deletes R2 objects in bucket `R2_BUCKET`; decrements `user_secrets.storage_bytes`; `revalidatePath('/', 'layout')`. Snapshots the root board only (children are not individually snapshotted); `affectedIds=[boardId]`.
**Gotcha:** Destructive and irreversible at the app level (snapshot captures only the root board row, not the full subtree). R2 cleanup is best-effort — a failed R2 batch delete does not abort the DB delete, so orphaned objects are possible.

---

### rename_board

**Purpose:** Rename a board (name only).

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board to rename. |
| `name` | string | yes | — | New name. |

**Underlying action** `renameBoard(boardId, name)` (actions.ts:482):
1. Requires auth.
2. Updates `boards` → `{ name }`, scoped by `id`+`user_id`.
3. `revalidatePath('/', 'layout')`.

**Returns:** void → `{ success: true }`.
**Side effects:** updates one `boards` row; `revalidatePath('/', 'layout')`. Snapshots the board; `affectedIds=[boardId]`.
**Note:** Functionally a subset of `update_board`; prefer `update_board` for multi-field changes.

---

### update_board

**Purpose:** Update one or more board properties: name, color, deadline, mode, meta (AI description).

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board to update. |
| `name` | string | no | — | New name. |
| `color` | string | no | — | New hex color. |
| `deadline` | string \| null | no | — | ISO date string, or `null` to clear. |
| `mode` | enum `classic`\|`trello`\|`text`\|`folder` | no | — | New board mode. |
| `meta` | string \| null | no | — | AI description (intended max ~150 chars), or `null` to clear. |

**Underlying action** `updateBoard(boardId, updates)` (actions.ts:491):
1. Requires auth.
2. Issues a single `boards.update(updates)` with exactly the fields present in `updates` (the tool spreads all optional params into the object), scoped by `id`+`user_id`, with `.select().single()`.
3. `revalidatePath('/', 'layout')`.

**Returns:** the updated board row.
**Side effects:** updates one `boards` row; `revalidatePath('/', 'layout')`. Snapshots the board; `affectedIds=[boardId]`.
**Gotchas:** No server-side validation/truncation of `meta` to 150 chars (the limit is only enforced by `suggestBoardMeta`, which slices to 150). The action does **not** call `layout_board_grid` when `mode` switches Trello→Classic — that must be done separately.

---

### layout_board_grid

**Purpose:** Spread a board's lists/cards into a kanban-style grid on the canvas. Intended to run after switching a board from Trello → Classic so items don't pile up at the origin.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board whose lists/cards to arrange. |

**Underlying action** `layoutBoardGrid(boardId)` (actions.ts:513):
1. Requires auth.
2. Fetches the board's `lists` (`id, position, x, y`) ordered by `position`; returns early (no-op) if none.
3. Fetches `cards` (`id, list_id, position, x, y`) for those lists, ordered by `position`.
4. Using constants `COL_W=280, ROW_H=64, CARD_TOP=96, GAP=40`: places list *i* at `x = GAP + i*COL_W, y = GAP`, and each card *j* in a list at `x = listX, y = CARD_TOP + j*ROW_H`.
5. **Only repositions items still at the origin** (`x===0 && y===0`) — a hand-arranged classic layout is never clobbered.
6. Applies all updates in parallel to `lists` and `cards`. **No `revalidatePath`.**

**Returns:** void → `{ success: true }`.
**Side effects:** updates `x`/`y` on `lists` and `cards` rows (only origin-positioned ones); no revalidation (client applies optimistically). Snapshots the board; `affectedIds=[boardId]`.
**Gotcha:** Although it mutates lists and cards, only the board is snapshotted/logged as affected — list/card prior positions are not captured for undo.

---

### set_board_synced

**Purpose:** Toggle whether a board is included in iOS sync.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board to toggle. |
| `synced` | boolean | yes | — | `true` = include in iOS sync, `false` = exclude. |

**Underlying action** `setBoardSynced(boardId, synced)` (actions.ts:273):
1. Requires auth.
2. Updates `boards` → `{ synced }`, scoped by `id`+`user_id`.
3. `revalidatePath('/', 'layout')`.

**Returns:** void → `{ success: true }`.
**Side effects:** updates `synced` on one `boards` row; `revalidatePath('/', 'layout')`. Snapshots the board; `affectedIds=[boardId]`.

---

### move_board_to_parent

**Purpose:** Re-parent a board (folder) under another board, or move it to top level.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `boardId` | string | yes | — | Board to move. |
| `newParentId` | string \| null | yes (nullable) | — | Target parent board ID, or `null` for top-level. |
| `fromParentId` | string | no | — | Current parent ID, used only to add an extra `revalidatePath('/board/{fromParentId}')`. |

**Underlying action** `moveBoardToParent(boardId, newParentId, fromParentId?)` (actions.ts:982):
1. Requires auth. Throws `Cannot move a folder into itself` if `boardId === newParentId`.
2. **Cycle guard:** if `newParentId` set, verifies the target exists and is owned by the user (`Target folder not found`), then walks up the parent chain from `newParentId`; if it reaches `boardId` it throws `Cannot move a folder into one of its own sub-folders` (a `seen` set also breaks any pre-existing loop).
3. Computes `tab_position` = max+1 among the destination's children (or among top-level boards when `newParentId` is null).
4. Updates the board → `{ parent_id: newParentId, tab_position }`, scoped by `id`+`user_id`. (Note: it does **not** clear `group_id` — only `move_tab` does that.)
5. Revalidates: `/board/{fromParentId}` (if given), `/board/{newParentId}` (if given), and `'/', 'layout'`.

**Returns:** void → `{ success: true }`.
**Side effects:** updates `parent_id`+`tab_position` on one `boards` row; up to three `revalidatePath` calls. Snapshots the moved board; `affectedIds=[boardId]`.

---

### copy_board_into

**Purpose:** Deep-copy an entire board subtree (the board plus its lists, cards, elements, edges, and all descendant boards) under a destination parent. Used e.g. to drag a folder out of a portal onto a canvas.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `sourceBoardId` | string | yes | — | Root of the subtree to copy. |
| `destParentBoardId` | string | yes | — | Parent board the copy is nested under. |
| `freeX` | number | no | `100` | Canvas X (`free_x`) of the new top-level copy. |
| `freeY` | number | no | `100` | Canvas Y (`free_y`) of the new top-level copy. |

**Underlying action** `copyBoardInto(sourceBoardId, destParentBoardId, freeX=100, freeY=100)` (actions.ts:896):
1. Requires auth. Verifies both source and destination boards exist and are owned by the user (`Source board not found` / `Destination board not found`).
2. Computes the destination's next `tab_position`.
3. Recursive `cloneSubtree(srcId, parentId, tabPos, fx?, fy?)`:
   - Clones the board row (copying `name, color, mode, content, deadline`, and `free_x`/`free_y` — overridden by `fx`/`fy` only at the top level), assigning `user_id`, `parent_id`, `tab_position`.
   - Clones all `lists` (building old→new `listMap`).
   - Clones all `cards` across those lists into the new lists (`cardMap`), copying title, description, position, x/y, done/done_at, deadline, recur_interval_minutes, hidden.
   - Clones all `board_elements` (`elMap`), copying type, x/y, width/height, data, deadline.
   - Clones all `board_edges`, **remapping** each edge's `source`/`target` endpoint via prefix-aware lookup (`list-`/`card-`/`el-` → new IDs from the maps) so connections survive.
   - Recurses into every child board (`parent_id = srcId`) ordered by `tab_position`.
4. `revalidatePath('/board/{destParentBoardId}')`.

**Returns:** the new top-level copied board row.
**Side effects:** inserts across `boards`, `lists`, `cards`, `board_elements`, `board_edges` for the whole subtree; `revalidatePath('/board/{destParentBoardId}')`. Snapshots the **source** board; `affectedIds=[sourceBoardId, destParentBoardId]` (explicitly passed).
**Gotchas:** R2 file objects are **not** duplicated — element `data` (including `storagePath`) is copied verbatim, so a copied textfile/PDF references the **same** underlying R2 object as the original; `user_secrets.storage_bytes` is **not** incremented. This is a deep DB copy with shared storage. Large subtrees issue many sequential round-trips (no transaction; a mid-way failure leaves a partial copy).

---

### ensure_mirror_portal

**Purpose:** Idempotently ensure a target board contains a portal element pointing back at a source board (the "mirror" of a portal relationship).

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `targetBoardId` | string | yes | — | Board that should contain the back-portal. |
| `backBoardId` | string | yes | — | Board the portal should point to. |

**Underlying action** `ensureMirrorPortal(targetBoardId, backBoardId)` (actions.ts:1118):
1. Requires auth.
2. Verifies the user owns `targetBoardId`; **silently returns** (no error) if not found / not owned.
3. Fetches existing `portal`-type `board_elements` on the target; if any already has `data.targetBoardId === backBoardId`, returns (idempotent no-op).
4. Otherwise inserts a portal element: `{ board_id: targetBoardId, type: 'portal', x:80, y:80, width:320, height:220, data: { targetBoardId: backBoardId, home: targetBoardId, vx:20, vy:20, zoom:0.4 } }`.
5. **No `revalidatePath`.**

**Returns:** void → `{ success: true }` (even when it no-ops or the target isn't owned).
**Side effects:** may insert one `board_elements` row (type `portal`); no revalidation. Snapshots the **target** board; `affectedIds=[targetBoardId, backBoardId]` (explicitly passed).
**Gotcha:** Returns success silently if the target board isn't owned by the user — the caller gets no signal that nothing happened.

---

### import_folder_tree

**Purpose:** Recreate a dropped folder tree under a parent board — each directory becomes a child board (mode `folder`), each text file becomes a `textfile` element.

**Parameters**

| name | type | required | default | meaning |
|------|------|----------|---------|---------|
| `parentBoardId` | string | yes | — | Board to import the tree under. |
| `tree` | object | yes | — | Folder tree: `{ name: string, files: [{name, content}], dirs: [...recursive] }`. The Zod schema validates `name`, `files` (array of `{name, content}`), and `dirs` as `array(unknown)`; nested dirs are validated structurally at runtime, not by the schema. |
| `color` | string | yes | — | Hex color applied to every created folder board. |

**Underlying action** `importFolderTree(parentBoardId, tree, color)` (actions.ts:861):
1. Requires auth.
2. Computes the parent's next `tab_position`.
3. Recursive `createDir(node, parentId, tabPos)`:
   - Inserts a `boards` row `{ name: node.name, color, user_id, parent_id: parentId, tab_position: tabPos, mode: 'folder' }`.
   - If `node.files` non-empty, bulk-inserts one `board_elements` row per file: `{ board_id, type: 'textfile', x:0, y:0, data: { name, content } }`. **Note: content is stored inline in the element `data` (DB-backed), not uploaded to R2** — so `storage_bytes` is not affected here.
   - Recurses into each sub-directory in order (tab_position = index).
4. `revalidatePath('/board/{parentBoardId}')`.

**Returns:** the top-level created folder board row.
**Side effects:** inserts across `boards` (one per directory) and `board_elements` (one `textfile` per file); `revalidatePath('/board/{parentBoardId}')`. Snapshots the **parent** board; `affectedIds=[parentBoardId]`.
**Gotchas:** No transaction — a deep tree is created via many sequential inserts; a failure mid-import leaves partial boards. The `claude_actions` log records only `{ parentBoardId, color }` — the imported `tree` (and therefore the file contents and structure) is **not** logged. Unlike `create_text_file`/`update_text_file`, imported files are stored DB-inline rather than in R2.

---

# List & Card Tools

This reference documents the Syncedsys MCP **list** and **card** write tools. Each tool is registered in `A:\Projects\syncedsys\app\api\mcp\route.ts` via `server.registerTool(...)`, and each delegates to a server action in `A:\Projects\syncedsys\app\actions.ts`.

## Cross-cutting behavior (applies to every tool below)

All tools in this set are **write tools**, so they are dispatched through the local `wrapWrite()` helper in `route.ts` (lines 95–111). For every invocation this means:

1. **Auth guard** — if there is no `userId`, it returns `Not authenticated` and does nothing.
2. **`affectedIds` resolution** — `affectedIds ?? (snapshot?.entityId ? [snapshot.entityId] : [])`. The explicit `affectedIds` array (when passed) wins; otherwise it falls back to the single snapshot entity id; otherwise it is empty.
3. **`snapshotBefore` (only when a `snapshot` arg is supplied)** — reads the current row of the entity from its table (`board→boards`, `list→lists`, `card→cards`, `element→board_elements`, `edge→board_edges`) and inserts the full row JSON into the **`snapshots`** table (`entity_type`, `entity_id`, `data`, `triggered_by` = tool name, `user_id`). This is the undo/diff capture. **Create-style tools pass no snapshot** (there is no pre-existing row), so no snapshot is written for them. Snapshot failures are swallowed (non-fatal).
4. **`logAction` (always)** — inserts a row into the **`claude_actions`** table (`tool`, `params`, `affected_ids`, `user_id`). Note the `params` logged are exactly the object passed as `wrapWrite`'s 2nd argument, which for some tools intentionally **omits bulky/secret fields** (e.g. `update_board_content` does not log `content`). Logging failures are swallowed (non-fatal).
5. **`wrap(fn)`** runs the underlying action; on success returns the action's return value as JSON text (or `{ success: true }` if the action returns `undefined`/null), and on throw returns the error message with `isError: true`.

**RLS / scope:** Every server action calls `createClient()` from `@/lib/supabase/server`. The route runs the whole MCP exchange inside `supabaseAuthContext.run({ accessToken })` (route.ts lines 964–970), so the Supabase client is bound to the authenticated user's JWT and **Postgres RLS is the only thing enforcing ownership**. The action bodies themselves filter **only by `id`/`board_id`/`list_id`, never by `user_id`** — so cross-user protection depends entirely on RLS policies on `lists`/`cards`. A caller passing an id they do not own will simply mutate nothing (RLS-filtered) rather than erroring.

**`revalidatePath` caveat:** Although `actions.ts` imports `revalidatePath`, **none of the list/card actions in this set call it.** UI freshness relies on the client's realtime subscription / local store, not Next.js cache revalidation. The `boardId` parameter threaded through almost every action is **not used by the action body** at all for lists/cards — it exists for the snapshot/log/affected-id bookkeeping in `route.ts` and for client-side cache keying, not for the DB write.

**`done_at` / recurrence note:** `cards` carries `done_at`, `deadline`, `recur_interval_minutes`, `hidden`, `x`, `y`, `position`, `list_id`, `title`, `description`, `done`. `deadline` and `recur_interval_minutes` are treated as **mutually exclusive** (setting one clears the other).

---

## LIST TOOLS

### create_list

**Purpose:** Create a new list (column) in a board, appended at the end.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `boardId` | string | yes | — | Board the list belongs to. |
| `name` | string | yes | — | List name. |
| `id` | string | no | auto (DB default UUID) | Optional explicit UUID for the new list (used so the client can pre-generate the id for optimistic insert / undo). |

**Underlying action — `createList(boardId, name, id?)` (actions.ts:545):**
1. Queries `lists` for the highest existing `position` where `board_id = boardId` (`order position desc, limit 1`).
2. Computes `position = existing[0].position + 1`, or `0` if the board has no lists.
3. Inserts into `lists`: `{ id? , board_id: boardId, name, position }` (the `id` key is only included when provided), then `.select().single()`.
4. Throws on insert error; otherwise returns the inserted row.

**Returns:** The full inserted list row (id, board_id, name, position, and DB defaults).

**Side effects:** Inserts into **`lists`**. Via `wrapWrite`: **no snapshot** (create), `logAction` row written with `affectedIds = [boardId]` (explicitly passed). No `revalidatePath`.

**Gotchas:** Position is "max+1" computed read-then-write — concurrent creates on the same board can race to the same position (no uniqueness enforced). If `boardId` is invalid/foreign, the insert fails (FK) or RLS blocks it and the action throws.

---

### delete_list

**Purpose:** Delete a list and (via DB cascade) its cards.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | List to delete. |
| `boardId` | string | yes | — | Owning board (bookkeeping only; unused in body). |

**Underlying action — `deleteList(listId, boardId)` (actions.ts:567):** Runs `supabase.from('lists').delete().eq('id', listId)`. Returns nothing.

**Returns:** Nothing → `wrap` reports `{ success: true }`.

**Side effects:** Deletes from **`lists`**. The tool's description states "Deletes a list and all its cards" — child `cards` removal is **not done in the action body**, so it relies on an **ON DELETE CASCADE FK** from `cards.list_id` → `lists.id` at the DB level. Via `wrapWrite`: snapshot of the list row is taken first (`{entityType:'list', entityId:listId}` → row JSON into `snapshots`); `logAction` with `affectedIds = [listId]`. No `revalidatePath`.

**Gotchas:** The pre-delete snapshot captures only the **list** row, not its cards, so an undo from the snapshot alone would not restore the cascaded cards. Deletion is permanent. RLS-filtered if not owned (silently deletes nothing).

---

### rename_list

**Purpose:** Change a list's name.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | List to rename. |
| `name` | string | yes | — | New name. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `renameList(listId, name, boardId)` (actions.ts:571):** `supabase.from('lists').update({ name }).eq('id', listId)`. Returns nothing.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`lists.name`**. Snapshot of list row first; `logAction` with `affectedIds = [listId]`. No `revalidatePath`.

---

### set_list_widget

**Purpose:** Toggle whether the list renders as a "widget".

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | Target list. |
| `isWidget` | boolean | yes | — | `true` = display as widget. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `setListWidget(listId, isWidget, boardId)` (actions.ts:575):** `update({ is_widget: isWidget }).eq('id', listId)`. (Note the camel→snake mapping: param `isWidget` → column `is_widget`.)

**Returns:** `{ success: true }`.

**Side effects:** Updates **`lists.is_widget`**. Snapshot of list row; `logAction` `affectedIds = [listId]`. No `revalidatePath`.

---

### set_list_deadline

**Purpose:** Set or clear a list's deadline.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | Target list. |
| `deadline` | string \| null | yes (nullable) | — | ISO date string, or `null` to clear. (`z.string().nullable()` — the value must be present in the payload but may be null.) |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `setListDeadline(listId, deadline, boardId)` (actions.ts:579):** `update({ deadline }).eq('id', listId)`. Writes the value verbatim (no validation/parsing of the date string).

**Returns:** `{ success: true }`.

**Side effects:** Updates **`lists.deadline`**. Snapshot of list row; `logAction` `affectedIds = [listId]`. No `revalidatePath`.

**Gotchas:** No server-side date validation — a malformed string can error at the DB column level (depending on column type) or be stored as-is.

---

### set_list_hidden

**Purpose:** Show/hide a list.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | Target list. |
| `hidden` | boolean | yes | — | `true` = hidden. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `setListHidden(listId, hidden, boardId)` (actions.ts:583):** `update({ hidden }).eq('id', listId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`lists.hidden`**. Snapshot of list row; `logAction` `affectedIds = [listId]`. No `revalidatePath`.

**localStorage caveat:** This sets a **persisted DB `hidden` flag** on the list row — it is the server-authoritative hide. It is distinct from any client-only hidden-map kept in `localStorage`; this tool does not touch localStorage.

---

### update_list_position

**Purpose:** Set a list's free-mode canvas X/Y coordinates.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | Target list. |
| `x` | number | yes | — | Canvas X. |
| `y` | number | yes | — | Canvas Y. |

**Note:** Unlike the other list tools, this one has **no `boardId` parameter** in its schema (route.ts:493).

**Underlying action — `updateListPosition(listId, x, y)` (actions.ts:666):** `update({ x, y }).eq('id', listId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`lists.x` / `lists.y`**. Snapshot of list row; `logAction` `affectedIds = [listId]`. No `revalidatePath`. Only meaningful for boards rendered in free/canvas mode.

---

## CARD TOOLS

### create_card

**Purpose:** Create a card appended at the end of a list.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | List to add the card to. |
| `title` | string | yes | — | Card title. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |
| `id` | string | no | auto (DB UUID) | Optional explicit UUID for the card. |

**Underlying action — `createCard(listId, title, boardId, id?)` (actions.ts:589):**
1. Reads max `position` of cards where `list_id = listId`.
2. `position = max+1` or `0` if empty.
3. Inserts into `cards`: `{ id?, list_id: listId, title, position }`, `.select().single()`.
4. Throws on error; returns the inserted row.

**Returns:** The full inserted card row.

**Side effects:** Inserts into **`cards`**. **No snapshot** (create); `logAction` with explicit `affectedIds = [listId]`. No `revalidatePath`.

**Gotchas:** Position is read-then-write max+1 — concurrent creates can collide. Created card has `x`/`y` unset (null) — use `create_free_card` for canvas placement.

---

### delete_card

**Purpose:** Permanently delete a card.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Card to delete. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `deleteCard(cardId, boardId)` (actions.ts:611):** `delete().eq('id', cardId)`.

**Returns:** `{ success: true }`.

**Side effects:** Deletes from **`cards`**. Snapshot of the card row taken first (enables undo); `logAction` `affectedIds = [cardId]`. No `revalidatePath`. Permanent.

---

### update_card

**Purpose:** Update a card's title and/or description.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Target card. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |
| `title` | string | no | unchanged | New title. |
| `description` | string | no | unchanged | New description. |

**Underlying action — `updateCard(cardId, { title, description }, boardId)` (actions.ts:615):** `update(updates).eq('id', cardId)` where `updates = { title, description }` exactly as passed from the tool.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards`** (`title`/`description`). Snapshot of card row; `logAction` `affectedIds = [cardId]`. No `revalidatePath`.

**Gotcha:** The route builds `updates` as `{ title, description }` and passes it straight through. Because the keys are always present (even when their Zod-optional values are `undefined`), the `.update()` payload literally contains `{ title: undefined, description: undefined }` for omitted fields. The Supabase JS client **drops `undefined` keys** when serializing, so an omitted field is left unchanged rather than nulled. Passing an explicit empty string `""` would overwrite the field with empty.

---

### update_card_done

**Purpose:** Mark a card done / not-done, stamping `done_at`.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Target card. |
| `done` | boolean | yes | — | `true` = done. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `updateCardDone(cardId, done, boardId)` (actions.ts:619):** `update({ done, done_at: done ? new Date().toISOString() : null }).eq('id', cardId)`. When marking done, `done_at` is set to the current server time (ISO); when un-done, `done_at` is cleared to null.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.done` and `cards.done_at`**. Snapshot of card row; `logAction` `affectedIds = [cardId]`. No `revalidatePath`.

**Gotcha / interplay with recurrence:** `done_at` exists specifically so recurring cards know when the current cycle started — for a card with `recur_interval_minutes`, checking it off resets to undone after the interval elapses (that reset logic lives in the client/recurrence layer, not in this action). This action only writes the flag + timestamp.

---

### set_card_deadline

**Purpose:** Set or clear a card's deadline (and clear any recurrence).

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Target card. |
| `deadline` | string \| null | yes (nullable) | — | ISO date string, or `null` to clear. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `setCardDeadline(cardId, deadline, boardId)` (actions.ts:624):**
1. `updates = { deadline }`.
2. **If `deadline` is truthy, also set `recur_interval_minutes = null`** (deadline and recurrence are mutually exclusive).
3. `update(updates).eq('id', cardId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.deadline`** (and **clears `cards.recur_interval_minutes`** when a non-null deadline is set). Snapshot of card row; `logAction` `affectedIds = [cardId]`. No `revalidatePath`.

**Gotcha:** Clearing the deadline (`null`) does **not** touch recurrence — only setting a non-null deadline clears recurrence.

---

### set_card_recur

**Purpose:** Set or clear a card's recurrence interval (minutes), clearing any deadline.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Target card. |
| `intervalMinutes` | number \| null | yes (nullable) | — | Minutes between recurrences, or `null` to clear recurrence. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `setCardRecur(cardId, intervalMinutes, boardId)` (actions.ts:633):**
1. `updates = { recur_interval_minutes: intervalMinutes }`.
2. **If `intervalMinutes != null`, also set `deadline = null`** (mutually exclusive with deadline).
3. `update(updates).eq('id', cardId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.recur_interval_minutes`** (and **clears `cards.deadline`** when a non-null interval is set). Snapshot of card row; `logAction` `affectedIds = [cardId]`. No `revalidatePath`.

**Behavior note:** When a recurring card is checked off, it auto-resets to undone after the interval elapses (handled by the recurrence layer using `done_at`); this action only writes the interval. Clearing recurrence (`null`) does not touch `deadline`.

---

### set_card_hidden

**Purpose:** Show/hide a card.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Target card. |
| `hidden` | boolean | yes | — | `true` = hidden. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `setCardHidden(cardId, hidden, boardId)` (actions.ts:640):** `update({ hidden }).eq('id', cardId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.hidden`** (server-persisted hide flag, distinct from any client localStorage hidden-map). Snapshot of card row; `logAction` `affectedIds = [cardId]`. No `revalidatePath`.

---

### move_card

**Purpose:** Move a card to a (possibly different) list and set its position.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Card to move. |
| `newListId` | string | yes | — | Destination list. |
| `newPosition` | number | yes | — | New position index within the destination list. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `moveCard(cardId, newListId, newPosition, boardId)` (actions.ts:644):** `update({ list_id: newListId, position: newPosition }).eq('id', cardId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.list_id` and `cards.position`** for the one card. Snapshot of the card row; `logAction` with explicit `affectedIds = [cardId, newListId]` (both the card and the destination list are recorded as affected). No `revalidatePath`.

**Gotcha:** This is a **single-card** update — it does **not** re-shuffle the positions of sibling cards, so it can create duplicate `position` values within a list. For a consistent reorder of the whole column, use `reorder_cards`.

---

### reorder_cards

**Purpose:** Bulk-update list membership and position for many cards at once.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `updates` | array of `{ id: string, list_id: string, position: number }` | yes | — | Full ordered set of per-card assignments to apply. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |

**Underlying action — `reorderCards(updates, boardId)` (actions.ts:653):** Maps over `updates` and issues one `cards.update({ list_id, position }).eq('id', u.id)` per entry, run concurrently via `Promise.all`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.list_id` / `cards.position`** for every card in `updates`. Via `wrapWrite`: **no snapshot** (this tool passes no `snapshot`), `logAction` is written with `params = { boardId, count: updates.length }` (the individual updates are **not** logged, only the count) and explicit `affectedIds = updates.map(u => u.id)`. No `revalidatePath`.

**Gotchas:** Updates are issued in parallel with no transaction — a partial failure can leave the board half-reordered. Because no snapshot is taken, there is no per-row undo capture for this operation. Caller is responsible for supplying a complete, consistent ordering.

---

### update_card_position

**Purpose:** Set a card's free-mode canvas X/Y coordinates.

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `cardId` | string | yes | — | Target card. |
| `x` | number | yes | — | Canvas X. |
| `y` | number | yes | — | Canvas Y. |

**Note:** No `boardId` parameter (route.ts:626).

**Underlying action — `updateCardPosition(cardId, x, y)` (actions.ts:671):** `update({ x, y }).eq('id', cardId)`.

**Returns:** `{ success: true }`.

**Side effects:** Updates **`cards.x` / `cards.y`**. Snapshot of card row; `logAction` `affectedIds = [cardId]`. No `revalidatePath`. Only meaningful in free/canvas board mode.

---

### create_free_card

**Purpose:** Create a card in a list at a specific canvas position (free mode).

**Parameters:**

| Name | Type | Req | Default | Meaning |
|------|------|-----|---------|---------|
| `listId` | string | yes | — | List to add the card to. |
| `title` | string | yes | — | Card title. |
| `boardId` | string | yes | — | Owning board (bookkeeping only). |
| `x` | number | yes | — | Canvas X. |
| `y` | number | yes | — | Canvas Y. |

**Underlying action — `createFreeCard(listId, title, boardId, x, y)` (actions.ts:676):**
1. Reads max `position` of cards in `listId`; `position = max+1` or `0`.
2. Inserts into `cards`: `{ list_id: listId, title, position, x, y }`, `.select().single()`.
3. Throws on error; returns the inserted row.

**Returns:** The full inserted card row (including `x`/`y`).

**Side effects:** Inserts into **`cards`**. **No snapshot** (create); `logAction` with explicit `affectedIds = [listId]`. No `revalidatePath`.

**Gotchas:** Same max+1 position read-then-write race as `create_card`. Unlike `create_card`, this **cannot** take an explicit `id` (no `id` parameter in the schema), so the DB always generates the UUID — the client cannot pre-assign the id for optimistic insert.

---

## Quick reference: snapshot vs. affectedIds per tool

| Tool | Snapshot entity | `affectedIds` logged |
|------|-----------------|----------------------|
| create_list | none (create) | `[boardId]` |
| delete_list | `list:listId` | `[listId]` |
| rename_list | `list:listId` | `[listId]` |
| set_list_widget | `list:listId` | `[listId]` |
| set_list_deadline | `list:listId` | `[listId]` |
| set_list_hidden | `list:listId` | `[listId]` |
| update_list_position | `list:listId` | `[listId]` |
| create_card | none (create) | `[listId]` |
| delete_card | `card:cardId` | `[cardId]` |
| update_card | `card:cardId` | `[cardId]` |
| update_card_done | `card:cardId` | `[cardId]` |
| set_card_deadline | `card:cardId` | `[cardId]` |
| set_card_recur | `card:cardId` | `[cardId]` |
| set_card_hidden | `card:cardId` | `[cardId]` |
| move_card | `card:cardId` | `[cardId, newListId]` |
| reorder_cards | none | `updates[].id` |
| update_card_position | `card:cardId` | `[cardId]` |
| create_free_card | none (create) | `[listId]` |

---

# Element & Edge Tools

This reference documents the Syncedsys MCP tools that manipulate **canvas elements** (`board_elements` table) and **edges/connections** (`board_edges` table) on free-mode boards.

- Tool definitions (names, Zod input schemas, descriptions): `A:\Projects\syncedsys\app\api\mcp\route.ts`
- Underlying server actions: `A:\Projects\syncedsys\app\actions.ts`
- Shared write plumbing: `A:\Projects\syncedsys\lib\mcp.ts`
- Element/edge type shapes: `A:\Projects\syncedsys\lib\types.ts` and renderer payloads in `A:\Projects\syncedsys\components\free\nodes.tsx`

---

## Cross-cutting behavior (applies to every tool below)

**`wrapWrite` wrapper (route.ts:95–111).** Every element/edge tool is a *write* tool routed through `wrapWrite(tool, params, fn, snapshot?, affectedIds?)`. Before the underlying action runs it:

1. Rejects with `'Not authenticated'` if `userId` is falsy.
2. Computes `affectedIds` = the explicit `affectedIds` argument, else `[snapshot.entityId]` if a snapshot was given, else `[]`.
3. Runs two fire-before operations in parallel (`Promise.all`):
   - `snapshotBefore(supabase, entityType, entityId, userId, tool)` — only when a `snapshot` arg with an `entityId` is supplied. Reads the *current* row from the entity's table (`board_elements` for `element`, `board_edges` for `edge`) via `select('*').eq('id', entityId)` and inserts it into the **`snapshots`** table (`{ entity_type, entity_id, data, triggered_by: tool, user_id }`). This is the undo/diff history. **Create-style tools pass no snapshot** (there is no pre-existing row), so they never write a snapshot.
   - `logAction(supabase, tool, params, ids, userId)` — inserts a row into the **`claude_actions`** audit table (`{ tool, params, affected_ids, user_id }`).
   - Both logging operations **swallow all errors** — a failed snapshot or audit-log never aborts the tool.
4. Calls `wrap(fn)` which runs the action and returns `ok(result ?? { success: true })` on success or `fail(message)` on a thrown error. `ok` JSON-stringifies non-string results; `fail` sets `isError: true`.

Note the `params` logged are NOT always the full input. Several tools deliberately omit bulky/secret fields from the audit log (e.g. `create_element` logs `{ boardId, type, x, y, width, height }` but **not** `data`; `create_text_file`/`update_text_file` omit `content`). The actual action still receives the full payload.

**RLS / auth scope (route.ts:953–971).** The route resolves auth via `resolveMcpAuth(req)`, then runs the entire MCP exchange inside `supabaseAuthContext.run({ accessToken })`. Every action's `createClient()` is therefore scoped to the authenticated user and **Supabase RLS applies automatically** — a user can only touch their own boards/elements/edges. Most element/edge actions do **not** re-check ownership in code; they rely on RLS. Exceptions that add an explicit ownership check: `moveElementToBoard` (verifies the *target* board belongs to the user) and `reorderFolderItems` (scopes board updates with `.eq('user_id', user.id)`).

**`revalidatePath` caveat.** Most element/edge actions perform **no** `revalidatePath` — the client (React Flow canvas) holds the source of truth in local state and updates optimistically. The only exceptions here are `moveElementToBoard` (revalidates the from/target board paths) — see per-tool notes. This means after an MCP write, a server-rendered page may show stale data until the client refetches.

**`board_elements` row shape** (`lib/types.ts`): `{ id, board_id, type, x, y, width|null, height|null, data (JSONB), deadline|null, created_at }`.

**`board_edges` row shape** (`lib/types.ts`): `{ id, board_id, source, target, source_handle|null, target_handle|null, data (JSONB), created_at }`.

---

## Canvas element types & their `data` payloads

The element `type` is one of nine values (`ELEMENT_TYPE = z.enum([...])`, route.ts:37). The DB columns `x, y, width, height, deadline` are first-class; everything else lives in the free-form `data` JSONB blob. The shapes below are reconstructed from the node renderers in `components/free/nodes.tsx` and creation sites — the MCP layer does **not** validate `data` beyond "is a record", so callers are responsible for supplying the right keys.

| type | Purpose | Key `data` fields (observed in renderers) |
|---|---|---|
| **shape** | A drawn shape (rect/ellipse/etc.) with optional centered label. | `shape` (string, e.g. `'rect'`), `fill` (hex, default `#93c5fd`), `label` (string). |
| **image** | An embedded image. | Either `url` (direct/data URL) **or** `storagePath` (R2 key, loaded via presigned URL); optional `sizeBytes`. |
| **drawing** | A freehand SVG path (pen tool). | `path` (SVG path `d`), `color` (default `#1d4ed8`), `strokeWidth` (default 2), `bbox` (`{ width, height }`), `scale` (default 1). |
| **text** | A free-floating sticky text note. | `text` (string), `color` (default `#1f2937`), `fontSize` (default 12). |
| **portal** | A live embedded mini-view of another board **or** a built-in viewer widget. | Board portal: `targetBoardId`, `targetBoardName`, `home`, `vx`/`vy` (pan, default 20/20), `zoom` (default 0.4), `locked`, `fitted`. Viewer portal: `viewerKind` ∈ `stocks` \| `slides` \| `google-calendar` \| `google-sheets` \| `google-docs`, with `viewerConfig` (e.g. `{ ticker, interval }`) and optional `viewer_context`. A portal is either a board portal **or** a viewer portal (the other group is nulled). |
| **textfile** | A named text file. Content stored in R2; row holds metadata only. | `name` (string), and when content exists `storagePath` (R2 key) + `sizeBytes`; legacy/fallback files inline `content`. Folder ordering stored as `folder_position`. |
| **folderlink** | A link tile that navigates to another (folder) board. | `name`, `targetBoardId`, `color` (default `#0079bf`). |
| **claude** | An embedded Claude chat node scoped to a board. | `boardId` (the board the chat has context for). Conversation state is managed by `ClaudeChat`, not stored inline here. |
| **pdf** | An embedded PDF document. | `name` (default `Document.pdf`), `storagePath` (R2 key), `pageCount` (number), optional extracted `text`, `sizeBytes`. URL minted on demand via `get_pdf_url`. |

`get_board_content` (route.ts:190–204) renders human-readable labels per type and is a good cross-check of which fields each type exposes (e.g. it reads `d.text`, `d.shape`/`d.label`, `d.name`, `d.pageCount`, `d.viewerKind`/`d.targetBoardId`).

---

# ELEMENT TOOLS

### `create_element`
**Purpose:** Create a new canvas element of any of the nine types on a board.

**Parameters:**
| name | type | req | default | meaning |
|---|---|---|---|---|
| `boardId` | string | yes | — | Board the element is placed on (`board_elements.board_id`). |
| `type` | enum (the 9 element types) | yes | — | Element type. |
| `x` | number | yes | — | Canvas X position. |
| `y` | number | yes | — | Canvas Y position. |
| `data` | record<string, unknown> | yes | — | Element-specific payload (see the type table above). Stored verbatim as JSONB. |
| `width` | number | no | `null` | Element width. |
| `height` | number | no | `null` | Element height. |

**What the action does** (`createElement`, actions.ts:758–772): `INSERT` into `board_elements` `{ board_id, type, x, y, data, width: width ?? null, height: height ?? null }`, then `.select().single()`. Throws on DB error.

**Returns:** the full inserted element row (incl. generated `id`).

**Side effects:** writes one `board_elements` row. No `revalidatePath`. No R2 work (even for image/pdf — those expect `data.storagePath` to already point at an uploaded object). Audit log omits `data` from `params`. No snapshot (create); `affectedIds = [boardId]`.

**Gotchas:** This is a thin insert — it does **not** validate that `data` matches the chosen `type`, does not create R2 objects, and does not adjust `user_secrets.storage_bytes`. For text files prefer `create_text_file` (which handles R2 upload + storage accounting).

---

### `update_element`
**Purpose:** Patch the position, size, `data`, and/or deadline of an existing element.

**Parameters:**
| name | type | req | default | meaning |
|---|---|---|---|---|
| `elementId` | string | yes | — | Target element id. |
| `x` | number | no | unchanged | New X. |
| `y` | number | no | unchanged | New Y. |
| `data` | record<string, unknown> | no | unchanged | **Replaces** the entire `data` blob (not a deep merge). |
| `width` | number | no | unchanged | New width. |
| `height` | number | no | unchanged | New height. |
| `deadline` | string \| null | no | unchanged | ISO date string, or `null` to clear. |

**What the action does** (`updateElement`, actions.ts:774–780): `UPDATE board_elements SET <updates> WHERE id = elementId`. The `updates` object passed through is exactly the supplied optional fields — only keys present are written. No read-modify-write.

**Returns:** nothing meaningful → wrapper returns `{ success: true }`.

**Side effects:** updates one `board_elements` row. Snapshot taken before (entityType `element`). Audit log records `{ elementId, x, y, width, height, deadline }` but **omits** `data`. No `revalidatePath`. No R2 / storage accounting.

**Gotchas:** Passing `data` **overwrites the whole JSONB blob** — to change one field you must send the complete merged object. There is no R2 cleanup here, so swapping a `storagePath` out via `update_element` would orphan the old object and leave `storage_bytes` overstated; use the type-specific tools when content is involved.

---

### `delete_element`
**Purpose:** Permanently delete a canvas element, cleaning up its backing R2 object if any.

**Parameters:**
| name | type | req | meaning |
|---|---|---|---|
| `elementId` | string | yes | Element to delete. |

**What the action does** (`deleteElement`, actions.ts:782–818):
1. Reads the element's `data` (`select('data').eq('id', elementId).maybeSingle()`).
2. If `data.storagePath` exists (pdf/image/textfile backed by R2): sends a `DeleteObjectCommand` to R2 (`R2_BUCKET`, key = `storagePath`), swallowing errors.
3. If `data.sizeBytes` is set: looks up the current user, reads `user_secrets.storage_bytes`, and upserts it down by `sizeBytes` (`Math.max(0, current - sizeBytes)`, `onConflict: 'user_id'`).
4. `DELETE FROM board_elements WHERE id = elementId`.

**Returns:** nothing → `{ success: true }`.

**Side effects:** deletes one `board_elements` row; deletes one R2 object (if `storagePath`); decrements `user_secrets.storage_bytes` (if `sizeBytes`). Snapshot taken before (entityType `element`) — enables undo. No `revalidatePath`.

**Gotchas:** R2/secrets cleanup is best-effort and silent. If the row had no `storagePath`/`sizeBytes`, only the DB row is removed.

---

### `create_text_file`
**Purpose:** Create a `textfile` element, uploading its content to R2 and tracking storage usage.

**Parameters:**
| name | type | req | default | meaning |
|---|---|---|---|---|
| `boardId` | string | yes | — | Board (often a folder board) to place the file on. |
| `name` | string | yes | — | File name (e.g. `notes.txt`). |
| `content` | string | yes | — | File contents (may be empty). |
| `x` | number | no | `0` | Canvas X. |
| `y` | number | no | `0` | Canvas Y. |

**What the action does** (`createTextFile`, actions.ts:823–854):
1. Requires an authenticated user (`auth.getUser()`), else throws `'Not authenticated'`.
2. Starts with `elData = { name }`.
3. If `content` is non-empty: builds R2 key `${user.id}/hub/textfiles/${randomUUID()}-${name}`, `PutObjectCommand`s the UTF-8 buffer (`ContentType: text/plain; charset=utf-8`), then sets `elData = { name, storagePath: key, sizeBytes }`. It **also** reads `user_secrets.storage_bytes` and fire-and-forgets an upsert adding `sizeBytes` (`onConflict: 'user_id'`). If the R2 put **throws**, it falls back to `elData = { name, content }` (content inlined in the DB row).
4. `INSERT` into `board_elements` `{ board_id, type: 'textfile', x, y, data: elData }` → `.select().single()`.

**Returns:** the inserted element row.

**Side effects:** one `board_elements` row; one R2 object (when content non-empty and R2 reachable); increments `user_secrets.storage_bytes`. No snapshot (create). No `revalidatePath`. Audit log omits `content`. `affectedIds = [boardId]`.

**Gotchas:** Empty-content files store only `{ name }` (no R2 object). The storage-bytes upsert is fire-and-forget (`.then(() => {})`), so accounting may lag. The R2 fallback path inlines content into the DB, which later `update_text_file` can migrate to R2.

---

### `update_text_file`
**Purpose:** Rename and/or rewrite a `textfile` element's content, migrating legacy DB-stored files to R2.

**Parameters:**
| name | type | req | meaning |
|---|---|---|---|
| `elementId` | string | yes | The `textfile` element. |
| `name` | string | yes | New file name (always applied). |
| `content` | string | yes | New content; empty string = name-only change for R2-backed files. |
| `boardId` | string | yes | Accepted but **ignored** by the action (param is `_boardId`). |

**What the action does** (`updateTextFile`, actions.ts:1028–1086):
1. Requires auth, else throws.
2. Reads existing `data`; extracts `storagePath`.
3. **If `storagePath` set (R2-backed):**
   - empty `content` → merged `{ ...existing, name }` (rename only; R2 object untouched).
   - non-empty → `PutObjectCommand` overwrites the same key, recomputes `sizeBytes`, sets `merged = { ...existing, name, sizeBytes }`, and adjusts `user_secrets.storage_bytes` by the delta (fire-and-forget, clamped ≥0). On R2 error, falls back to `{ ...existing, name }`.
4. **Else if `content` non-empty (legacy DB-backed):** migrates to R2 — new key, `PutObjectCommand`, set `storagePath`+`sizeBytes`, `delete merged.content`, add `sizeBytes` to storage. On R2 error, `{ ...existing, name, content }`.
5. **Else** (no storagePath, empty content): `merged = { ...existing, name }`.
6. `UPDATE board_elements SET data = merged WHERE id = elementId`.

**Returns:** nothing → `{ success: true }`.

**Side effects:** updates one `board_elements` row; may write an R2 object; may adjust `user_secrets.storage_bytes` (delta). Snapshot taken before (entityType `element`). No `revalidatePath`. Audit log omits `content`.

**Gotchas:** `boardId` is required by the schema but unused. Content merges over the existing `data` (preserves other keys like `folder_position`, `deadline` mirror, etc.). Storage-bytes updates are fire-and-forget.

---

### `move_element_to_board`
**Purpose:** Move an element to a different board the user owns, resetting its position to the origin.

**Parameters:**
| name | type | req | meaning |
|---|---|---|---|
| `elementId` | string | yes | Element to move. |
| `targetBoardId` | string | yes | Destination board. |
| `fromBoardId` | string | no | Source board, used only for cache revalidation. |

**What the action does** (`moveElementToBoard`, actions.ts:1017–1026):
1. Requires auth.
2. **Verifies ownership of the target** — `select('id').eq('id', targetBoardId).eq('user_id', user.id).single()`; throws `'Target board not found'` if not owned/missing.
3. `UPDATE board_elements SET board_id = targetBoardId, x = 0, y = 0 WHERE id = elementId` (position reset to (0,0)).
4. `revalidatePath('/board/{fromBoardId}')` if `fromBoardId` given, and `revalidatePath('/board/{targetBoardId}')`.

**Returns:** nothing → `{ success: true }`.

**Side effects:** updates one `board_elements` row (board_id + position). **Revalidates** source (if provided) and target board paths — unusual among these tools. Snapshot taken before (entityType `element`). `affectedIds = [elementId, targetBoardId]`.

**Gotchas:** Position is always reset to `(0,0)` on move — you must reposition afterward with `update_element`. Only the *target* board ownership is checked explicitly; the element/source are guarded by RLS.

---

### `upsert_element`
**Purpose:** Insert-or-update an element by a caller-supplied id — built for undo/redo restore (re-create a deleted element with its original id).

**Parameters:**
| name | type | req | default | meaning |
|---|---|---|---|---|
| `id` | string | yes | — | Explicit element id to upsert. |
| `boardId` | string | yes | — | Board id. |
| `type` | enum (9 types) | yes | — | Element type. |
| `x` | number | yes | — | Canvas X. |
| `y` | number | yes | — | Canvas Y. |
| `data` | record<string, unknown> | yes | — | Full `data` blob. |
| `width` | number \| null | no | `null` | Width. |
| `height` | number \| null | no | `null` | Height. |

**What the action does** (`upsertElement`, actions.ts:1136–1149): `supabase.from('board_elements').upsert({ id, board_id, type, x, y, data, width: width ?? null, height: height ?? null })`. Inserts if `id` is new, replaces the row if it exists. Throws on error.

**Returns:** nothing → `{ success: true }`.

**Side effects:** one `board_elements` upsert. Snapshot taken before (entityType `element`) — captures the row if it currently exists. No `revalidatePath`. **No R2 / storage accounting** — restoring a textfile/pdf this way does not re-create or re-count its R2 object.

**Gotchas:** A full row replace — any field you omit reverts to its default (e.g. `deadline` is not settable here and would be cleared on overwrite). Intended for restoring a known-good prior snapshot, not for partial edits (use `update_element`).

---

### `reorder_folder_items`
**Purpose:** Bulk-reorder the sub-folders and files shown inside a folder board.

**Parameters:**
| name | type | req | meaning |
|---|---|---|---|
| `parentBoardId` | string | yes | The folder board whose children are being reordered. Logged only; not used in the query bodies. |
| `folderIds` | string[] | yes | Full ordered list of child **board** ids (sub-folders). |
| `fileIds` | string[] | yes | Full ordered list of **element** ids (files in the folder). |

**What the action does** (`reorderFolderItems`, actions.ts:1091–1115):
1. Requires auth.
2. For each `fileId` (index `i`): reads the element's current `data`, merges `{ ...existing, folder_position: i }`, and `UPDATE board_elements SET data = merged WHERE id`. (File order is stored as `folder_position` inside the JSONB blob — no schema migration needed.)
3. In parallel (`Promise.all`), for each `folderId` (index `i`): `UPDATE boards SET tab_position = i WHERE id AND user_id = user.id` (board ownership scoped).
4. **No `revalidatePath`** — "the caller holds the source of truth in local state."

**Returns:** nothing → `{ success: true }`.

**Side effects:** updates `tab_position` on the listed `boards` rows and `data.folder_position` on the listed `board_elements` rows. No snapshot (no single entity). Audit log records counts: `{ parentBoardId, folderCount, fileCount }`. `affectedIds = [...folderIds, ...fileIds]`.

**Gotchas:** Each file update is a read-then-write (N round trips); large folders mean many queries. `parentBoardId` is not used to scope the updates — items are addressed purely by id (RLS + the per-folder `user_id` check on boards provide safety). Because there's no revalidation, server-rendered views can be stale until the client refetches.

---

# EDGE TOOLS

Edges are connections between two canvas nodes (elements/cards/etc.), stored in `board_edges`. `source`/`target` are node ids; `source_handle`/`target_handle` identify the specific connection points (handles) on each node. `data` holds shape metadata (e.g. a quadratic-bend control point).

### `create_edge`
**Purpose:** Create a connection (edge) between two canvas nodes.

**Parameters:**
| name | type | req | default | meaning |
|---|---|---|---|---|
| `boardId` | string | yes | — | Board the edge belongs to. |
| `source` | string | yes | — | Source node id. |
| `target` | string | yes | — | Target node id. |
| `sourceHandle` | string | no | `null` | Source connection handle. |
| `targetHandle` | string | no | `null` | Target connection handle. |

**What the action does** (`createEdge`, actions.ts:687–695): `INSERT` into `board_edges` `{ board_id, source, target, source_handle: sourceHandle ?? null, target_handle: targetHandle ?? null }` → `.select().single()`. Throws on error. (`data` is left to its column default — empty.)

**Returns:** the inserted edge row (incl. generated `id`).

**Side effects:** one `board_edges` row. No snapshot (create). No `revalidatePath`. `affectedIds = [boardId]`.

**Gotchas:** No validation that `source`/`target` reference real nodes — referential integrity is the caller's responsibility (orphan edges are possible if a node id is wrong). `data` cannot be set here; use `update_edge_shape` afterward to add bend geometry.

---

### `delete_edge`
**Purpose:** Delete a canvas edge/connection.

**Parameters:**
| name | type | req | meaning |
|---|---|---|---|
| `edgeId` | string | yes | Edge to delete. |

**What the action does** (`deleteEdge`, actions.ts:697–700): `DELETE FROM board_edges WHERE id = edgeId`. No error is re-thrown (result not checked).

**Returns:** nothing → `{ success: true }`.

**Side effects:** removes one `board_edges` row. Snapshot taken before (entityType `edge`) — enables undo. No `revalidatePath`.

**Gotchas:** Silent if the id doesn't exist (delete of zero rows still "succeeds"). RLS scopes the delete to the user's edges.

---

### `update_edge_shape`
**Purpose:** Update the shape/geometry `data` of an edge (e.g. a bend control point).

**Parameters:**
| name | type | req | meaning |
|---|---|---|---|
| `edgeId` | string | yes | Edge to modify. |
| `data` | record<string, unknown> | yes | Edge shape data, e.g. `{ cx, cy }` for a quadratic bend. **Replaces** the whole `data` blob. |

**What the action does** (`updateEdgeShape`, actions.ts:702–705): `UPDATE board_edges SET data = <data> WHERE id = edgeId`. Result not checked.

**Returns:** nothing → `{ success: true }`.

**Side effects:** updates one `board_edges` row's `data`. Snapshot taken before (entityType `edge`). Audit log records `{ edgeId }` only (omits `data`). No `revalidatePath`.

**Gotchas:** Whole-blob overwrite — send the complete shape object, not a partial patch. Only `data` is mutable here; endpoints/handles are changed via `upsert_edge`.

---

### `upsert_edge`
**Purpose:** Insert-or-update an edge by a caller-supplied id — built for undo/redo restore.

**Parameters:**
| name | type | req | default | meaning |
|---|---|---|---|---|
| `id` | string | yes | — | Explicit edge id to upsert. |
| `boardId` | string | yes | — | Board id. |
| `source` | string | yes | — | Source node id. |
| `target` | string | yes | — | Target node id. |
| `sourceHandle` | string \| null | no | `null` | Source handle. |
| `targetHandle` | string \| null | no | `null` | Target handle. |

**What the action does** (`upsertEdge`, actions.ts:708–714): `supabase.from('board_edges').upsert({ id, board_id, source, target, source_handle: sourceHandle ?? null, target_handle: targetHandle ?? null })`. Inserts if new, replaces if the id exists. Throws on error.

**Returns:** nothing → `{ success: true }`.

**Side effects:** one `board_edges` upsert. Snapshot taken before (entityType `edge`) — captures the row if it currently exists. No `revalidatePath`.

**Gotchas:** A full row replace — `data` (edge shape) is **not** included in the upsert payload, so restoring an edge this way **resets its `data` to the column default**, dropping any bend geometry. Reapply shape with `update_edge_shape` if needed. Intended for restoring endpoints/handles during undo/redo, not partial edits.

---

## Quick summary

| Tool | Table | Snapshot (undo) | revalidatePath | R2 / storage_bytes |
|---|---|---|---|---|
| create_element | board_elements | no (create) | no | no |
| update_element | board_elements | yes (element) | no | no |
| delete_element | board_elements | yes (element) | no | deletes R2 obj + decrements bytes (if storagePath/sizeBytes) |
| create_text_file | board_elements | no (create) | no | uploads R2 + increments bytes (if content) |
| update_text_file | board_elements | yes (element) | no | uploads R2 + adjusts bytes by delta; migrates legacy DB→R2 |
| move_element_to_board | board_elements | yes (element) | **yes** (from+target) | no (position reset to 0,0; checks target ownership) |
| upsert_element | board_elements | yes (element) | no | no |
| reorder_folder_items | boards + board_elements | no | no | no (file order via data.folder_position; folder order via boards.tab_position) |
| create_edge | board_edges | no (create) | no | — |
| delete_edge | board_edges | yes (edge) | no | — |
| update_edge_shape | board_edges | yes (edge) | no | — |
| upsert_edge | board_edges | yes (edge) | no | — (drops edge.data on restore) |

---

## Device, Settings & Account-Link Tools

Reference for the Syncedsys MCP server tools in three groups: **Device** pairing, **Settings** (Anthropic key / Claude flags / stocks flag), and **Account-Link** management.

### Cross-cutting mechanics (applies to every tool below)

- **Auth context / RLS.** The route handler (`A:\Projects\syncedsys\app\api\mcp\route.ts`, `handle()`) resolves auth via `resolveMcpAuth(req)`, then runs the whole MCP exchange inside `supabaseAuthContext.run({ accessToken })`. Every server action calls `createClient()` which is scoped to that user, so **Supabase RLS applies** and each action additionally re-checks `supabase.auth.getUser()` and throws `'Not authenticated'` when absent. Most actions also filter writes by `.eq('user_id', user.id)` (or equivalent) so they cannot touch another user's rows even if RLS were permissive.
- **`wrapWrite` envelope (write tools only).** All write tools are wrapped by `wrapWrite(tool, params, fn, snapshot?, affectedIds?)` in `buildServer`. Before running the action it does two things in parallel: (1) `snapshotBefore(...)` — only if a `snapshot.entityId` is provided (none of the tools in this set pass one, so **no snapshot rows are written** for any tool here); (2) `logAction(supabase, tool, params, ids, userId)` which inserts a row into the **`claude_actions`** table (`tool`, `params`, `affected_ids`, `user_id`). Both logging calls swallow their own errors (non-fatal). `wrapWrite` returns `fail('Not authenticated')` if `userId` is empty. The action's return value (or `{ success: true }` if it returns `undefined`/null) is JSON-serialized back to the caller; thrown errors become `{ isError: true, text: <message> }`.
- **Read tools** (`get_claude_status`, `get_stocks_enabled`) bypass `wrapWrite` entirely — they call `wrap(fn)` directly, so they write **no** `claude_actions` log row and do **no** snapshot.
- **`params` logged to `claude_actions`** is exactly the object passed as the 2nd arg to `wrapWrite` (noted per tool). Note `save_anthropic_key` deliberately logs `{}` so the key value never lands in the log table.

---

### create_device_link

**Purpose:** Create a pending iOS device-pairing link and return a 6-character pairing code.

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `name` | string | optional | `'iOS device'` | Display name for the device. Schema marks it optional; the default `'iOS device'` is supplied by the action's signature (`createDeviceLink(name = 'iOS device')`), not by Zod, so if the MCP layer passes `undefined` the action default applies. |

**Underlying action** (`createDeviceLink`, `app/actions.ts:282`):
1. `createClient()`; `getUser()`; throw `'Not authenticated'` if no user.
2. Generate a 6-char `code` from the alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (deliberately omits ambiguous chars I/O/0/1) using `Math.random()`.
3. Generate a long `token` = `crypto.randomUUID() + crypto.randomUUID().replace(/-/g,'')`.
4. Insert into **`device_links`**: `{ user_id, name, pairing_code: code, token }`, then `.select().single()`. Throws on DB error.
5. `revalidatePath('/', 'layout')`.
6. Return `{ code, id }` (the new row's id).

**Returns:** `{ code: string, id: string }` — `code` is what the user types into the iOS app at `/api/devices/pair` to complete pairing (that endpoint marks the row paired and returns the `token`).

**Side effects:** Inserts a `device_links` row; `revalidatePath('/', 'layout')`; plus the `wrapWrite` `claude_actions` log row (`tool='create_device_link'`, `params={ name }`, `affected_ids=[]` since no snapshot id and no explicit `affectedIds`).

**Scope/gotchas:** The pairing code uses `Math.random()` (not cryptographically secure) — fine as a short-lived pairing handle, but the real bearer secret is the UUID-derived `token`. A paired device's token grants `/api/sync` access to **all** of that user's boards/lists/cards/elements, so removing stale links matters. `affected_ids` logged as `[]` because the new id isn't known at log time.

---

### remove_device_link

**Purpose:** Delete a device link (paired or unpaired).

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `id` | string | **required** | — | The `device_links` row id to remove. |

**Underlying action** (`removeDeviceLink`, `app/actions.ts:297`):
1. `createClient()`; `getUser()`; throw `'Not authenticated'` if no user.
2. `supabase.from('device_links').delete().eq('id', id).eq('user_id', user.id)` — the `user_id` filter guarantees a user can only delete their own links. No error is thrown if nothing matches (delete of zero rows succeeds silently).
3. `revalidatePath('/', 'layout')`.
4. Returns `undefined` → MCP reports `{ success: true }`.

**Returns:** Nothing meaningful; `{ success: true }` to the caller.

**Side effects:** Deletes the matching `device_links` row; `revalidatePath('/', 'layout')`; `claude_actions` log row (`params={ id }`, `affected_ids=[id]` — passed explicitly as the `affectedIds` arg).

**Scope/gotchas:** Revoking a link invalidates that device's sync token immediately. Deleting a non-existent / not-owned id is a silent no-op (no error), so success does not guarantee a row was deleted.

---

### save_anthropic_key

**Purpose:** Encrypt and store the user's Anthropic API key.

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `key` | string | **required** | — | Anthropic API key. Validated to start with `sk-ant-`. |

**Underlying action** (`saveAnthropicKey`, `app/actions.ts:21`):
1. `createClient()`; `getUser()`. If no user → returns `{ ok: false, error: 'Not authenticated' }` (does **not** throw).
2. `trim()` the key; if it does not start with `sk-ant-` → `{ ok: false, error: 'That does not look like an Anthropic API key …' }`.
3. `encryptSecret(trimmed)` (from `@/lib/crypto`, uses `APP_ENCRYPTION_KEY`). On failure → `{ ok: false, error: 'Encryption failed: …' }`.
4. Upsert into **`user_secrets`**: `{ user_id, anthropic_key_encrypted: encrypted, updated_at }` with `onConflict: 'user_id'`. On DB error → `{ ok: false, error: 'Database error: …' }`.
5. `revalidatePath('/settings')`; return `{ ok: true }`.

**Returns:** `{ ok: boolean, error?: string }`. Returns a **structured** result (not thrown) so the real failure reason survives Next.js production error stripping. The encrypted/plaintext key is never returned.

**Side effects:** Upserts `user_secrets.anthropic_key_encrypted`; `revalidatePath('/settings')`; `claude_actions` log row. **Important:** the `wrapWrite` params are hard-coded to `{}` (not `{ key }`), so the API key is **never written to the action log**. `affected_ids=[]`.

**Scope/gotchas:** Requires `APP_ENCRYPTION_KEY` on the server or encryption fails. Storing a user key makes that user "bring-your-own-key": downstream Claude calls resolve to the user key (`tryResolveAnthropicKey`) and bypass the platform free-tier gate. RLS + `user_id` upsert key ensure a user only writes their own secret row.

---

### remove_anthropic_key

**Purpose:** Clear the stored Anthropic API key.

**Parameters:** none (`inputSchema: undefined`).

**Underlying action** (`removeAnthropicKey`, `app/actions.ts:44`):
1. `createClient()`; `getUser()`; **throws** `'Not authenticated'` if no user (unlike `saveAnthropicKey`, this one throws).
2. `supabase.from('user_secrets').update({ anthropic_key_encrypted: null }).eq('user_id', user.id)` — nulls the column rather than deleting the row (keeps other flags like `claude_auto_apply` / `claude_pay_per_use` intact).
3. `revalidatePath('/settings')`. Returns `undefined` → `{ success: true }`.

**Returns:** `{ success: true }`.

**Side effects:** Sets `user_secrets.anthropic_key_encrypted = null`; `revalidatePath('/settings')`; `claude_actions` log row (`params={}`, `affected_ids=[]`).

**Scope/gotchas:** After removal the user falls back to the platform key (if `ANTHROPIC_API_KEY` is set) and is re-subjected to the free-tier/pay-per-use gate. Does not clear usage ledger rows. No-op-safe if no row exists (update of zero rows succeeds).

---

### set_claude_auto_apply

**Purpose:** Toggle whether Claude may perform write actions (true = writes enabled; false = read-only).

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `enabled` | boolean | **required** | — | `true` allows write tools; `false` makes Claude read-only. |

**Underlying action** (`setClaudeAutoApply`, `app/actions.ts:54`):
1. `createClient()`; `getUser()`; throws `'Not authenticated'` if no user.
2. Upsert into **`user_secrets`**: `{ user_id, claude_auto_apply: enabled, updated_at }`, `onConflict: 'user_id'`. Throws on error.
3. `revalidatePath('/settings')`. Returns `undefined` → `{ success: true }`.

**Returns:** `{ success: true }`.

**Side effects:** Upserts `user_secrets.claude_auto_apply`; `revalidatePath('/settings')`; `claude_actions` log row (`params={ enabled }`, `affected_ids=[]`).

**Scope/gotchas:** The action only **persists** the flag — it does not itself guard writes. Per the code comment, board **scope (down-only access)** is always enforced regardless of this flag; this toggle governs whether write tools run at all. Enforcement of the flag lives elsewhere (the consuming Claude/gate layer), not in this action.

---

### get_claude_status

**Purpose:** Report whether an Anthropic key is stored and whether auto-apply is on.

**Parameters:** none (`inputSchema: undefined`).

**Underlying action** (`getClaudeStatus`, `app/actions.ts:80`):
1. `createClient()`; `getUser()`. If no user → returns `{ hasKey: false, autoApply: false }` (does not throw).
2. Select `anthropic_key_encrypted, claude_auto_apply` from **`user_secrets`** for the user, `.maybeSingle()`.
3. Return `{ hasKey: !!data?.anthropic_key_encrypted, autoApply: !!data?.claude_auto_apply }`.

**Returns:** `{ hasKey: boolean, autoApply: boolean }`. Never returns the key itself, only its presence.

**Side effects:** **None** (read-only). Called via `wrap`, not `wrapWrite`, so **no** `claude_actions` log row and **no** revalidate.

**Scope/gotchas:** Boolean coercion means a row with a `null` encrypted key reports `hasKey: false`. RLS/`user_id` filter scope it to the caller.

---

### set_stocks_enabled

**Purpose:** Enable/disable the Stock Viewer feature for the user.

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `enabled` | boolean | **required** | — | `true` enables the Stock Viewer; `false` disables it. |

**Underlying action** (`setStocksEnabled`, `app/actions.ts:1161`):
1. `createClient()`; `getUser()`; throws `'Not authenticated'` if no user.
2. `supabase.auth.updateUser({ data: { stocks_enabled: enabled } })` — stored in **Supabase Auth `user_metadata`** (merged into `raw_user_meta_data`), **not** a DB table column. Throws on error.
3. `revalidatePath('/settings/connected-apps')` and `revalidatePath('/stocks')`. Returns `void` → `{ success: true }`.

**Returns:** `{ success: true }`.

**Side effects:** Mutates the authenticated user's `auth.users.user_metadata.stocks_enabled`; revalidates `/settings/connected-apps` and `/stocks`; `claude_actions` log row (`params={ enabled }`, `affected_ids=[]`).

**Scope/gotchas:** Per repo notes (`CLAUDE.md`/`HANDOFF.md`), this flag **needs no migration** because it lives in Auth metadata. The `stocks_enabled` flag still gates the Sidebar / Stock Viewer button (settings UI in `components/StockViewerSettings.tsx`). Self-scoped: `updateUser` only affects the calling user.

---

### get_stocks_enabled

**Purpose:** Report whether the Stock Viewer feature is enabled for the user.

**Parameters:** none (`inputSchema: undefined`).

**Underlying action** (`getStocksEnabled`, `app/actions.ts:1155`):
1. `createClient()`; `getUser()`.
2. Return `!!(user?.user_metadata?.stocks_enabled)`.

**Returns:** `boolean`.

**Side effects:** **None** (read-only). Called via `wrap`; no log row, no revalidate. Note it does **not** throw when unauthenticated — it simply returns `false` (the optional-chaining short-circuits).

**Scope/gotchas:** Reads from Auth `user_metadata`, so it reflects whatever `set_stocks_enabled` last wrote. Self-scoped to the authenticated user.

---

### link_account  — ⚠ dead/unused code

**Purpose:** Link another user account to the current user as a "member".

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `memberId` | string | **required** | — | The user ID being linked to the current (owner) account. |
| `label` | string | **required** | — | Display label for the linked account (trimmed; empty → `'Linked account'`). |

**Underlying action** (`linkAccount`, `app/actions.ts:1219`):
1. `createClient()`; `getUser()`; throws `'Not authenticated'` if no user.
2. If `memberId === user.id` → throw `'Cannot link to yourself'`.
3. Insert into **`account_links`**: `{ owner_id: user.id, member_id: memberId, label: label.trim() || 'Linked account' }`, `.select().single()`.
4. On error: if Postgres code `23505` (unique violation) → throw `'Already linked to this account'`; else rethrow.
5. `revalidatePath('/settings')`; return the inserted row.

**Returns:** The new `account_links` row.

**Side effects:** Inserts an `account_links` row (default `status` presumably `pending`); `revalidatePath('/settings')`; `claude_actions` log row (`params={ memberId, label }`, `affected_ids=[memberId]`).

**Scope/gotchas:** **Flagged as dead code in the repo.** `CLAUDE.md:91` / `HANDOFF.md:99`: "`account_links` table exists but is effectively unused." `CLAUDE.md:126` / `HANDOFF.md:136`: "`app/(app)/settings/SettingsClient.tsx` + `account_links` are dead code — safe to delete." The action works mechanically, but nothing in the app consumes the resulting links. No validation that `memberId` is a real user.

---

### accept_link  — ⚠ dead/unused code

**Purpose:** Accept a pending account-link invitation (as the invited member).

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `linkId` | string | **required** | — | The `account_links` row id to accept. |

**Underlying action** (`acceptLink`, `app/actions.ts:1238`):
1. `createClient()`; `getUser()`; throws `'Not authenticated'` if no user.
2. `update({ status: 'accepted' }).eq('id', linkId).eq('member_id', user.id)` — only the **member** of the link can accept it (the `member_id` filter enforces this). No error thrown if nothing matches.
3. `revalidatePath('/settings')`. Returns `undefined` → `{ success: true }`.

**Returns:** `{ success: true }`.

**Side effects:** Sets `account_links.status='accepted'` for the matching row; `revalidatePath('/settings')`; `claude_actions` log row (`params={ linkId }`, `affected_ids=[linkId]`).

**Scope/gotchas:** **Dead code** (same repo flags as `link_account`). Silent no-op if `linkId` doesn't exist or the caller isn't the `member_id`, so a "success" response does not confirm a row changed.

---

### remove_link  — ⚠ dead/unused code

**Purpose:** Remove an account link, callable by either side (owner or member).

**Parameters**

| Name | Type | Required | Default | Meaning |
|------|------|----------|---------|---------|
| `linkId` | string | **required** | — | The `account_links` row id to remove. |

**Underlying action** (`removeLink`, `app/actions.ts:1252`):
1. `createClient()`; `getUser()`; throws `'Not authenticated'` if no user.
2. `delete().eq('id', linkId).or('owner_id.eq.<uid>,member_id.eq.<uid>')` — deletes the link if the caller is **either** its owner **or** its member. No error if nothing matches.
3. `revalidatePath('/settings')` **and** `revalidatePath('/overview')`. Returns `undefined` → `{ success: true }`.

**Returns:** `{ success: true }`.

**Side effects:** Deletes the matching `account_links` row; revalidates `/settings` and `/overview`; `claude_actions` log row (`params={ linkId }`, `affected_ids=[linkId]`).

**Scope/gotchas:** **Dead code** (same repo flags). The `.or(...)` filter interpolates `user.id` directly into the PostgREST filter string; since `user.id` is a server-derived UUID this is not user-controlled injection, but it's the one action in this group with that pattern. Silent no-op when the row isn't owned/membered by the caller.

---

### Summary of dead-code flags

Per `A:\Projects\syncedsys\CLAUDE.md` and `A:\Projects\syncedsys\HANDOFF.md`:

- **`link_account`, `accept_link`, `remove_link`** all operate on the **`account_links`** table, which is documented as **"effectively unused"** and **"dead code — safe to delete"** (alongside `app/(app)/settings/SettingsClient.tsx`). The MCP tools and their actions are functional but no live feature consumes them.
- The **Device** and **Settings** tools are all live: `device_links` backs the iOS `/api/sync` + `/api/devices/pair` flow; `user_secrets` backs the Claude key/auto-apply settings; `stocks_enabled` (in Auth `user_metadata`) still gates the Stock Viewer UI.

### Relevant file paths
- Tool definitions / schemas: `A:\Projects\syncedsys\app\api\mcp\route.ts` (device lines 844–861, settings 865–911, account-links 915–946; `wrapWrite` 95–111; route/auth 953–971).
- Server actions: `A:\Projects\syncedsys\app\actions.ts` (`saveAnthropicKey` 21, `removeAnthropicKey` 44, `setClaudeAutoApply` 54, `getClaudeStatus` 80, `createDeviceLink` 282, `removeDeviceLink` 297, `getStocksEnabled` 1155, `setStocksEnabled` 1161, `linkAccount` 1219, `acceptLink` 1238, `removeLink` 1252).
- Logging/snapshot helpers: `A:\Projects\syncedsys\lib\mcp.ts` (`snapshotBefore`, `logAction`).
- Dead-code notes: `A:\Projects\syncedsys\CLAUDE.md` (lines 80, 91, 126) and `A:\Projects\syncedsys\HANDOFF.md` (lines 79, 99, 136).

---

# Research Tools (i.syncedsys satellite)

These tools call the **i.syncedsys** research API over HTTP — they do **not** touch the local Supabase. All auth and base-URL composition lives in one place: `researchFetch()` in `A:\Projects\syncedsys\lib\research.ts`, which injects `Authorization: Bearer ${RESEARCH_API_SECRET}` against `RESEARCH_API_BASE_URL` (default `https://i.syncedsys.com`), parses the JSON body, and throws on a non-2xx (the route's `wrap()` turns that throw into an MCP error result). There is **no `wrapWrite`/snapshot/undo** here — writes go to the external service, not a local board entity.

> **Config:** `RESEARCH_API_SECRET` must be byte-for-byte identical to `MCP_SECRET` in the syncedsys-i satellite, or **every** research tool returns `401`. Set both `RESEARCH_API_BASE_URL` and `RESEARCH_API_SECRET` in `.env.local` (and in Vercel for production).

## The two-phase workflow

**Phase 2 — enrich (assign structural tags):**
1. `research_list_domains` → read the domain's `enrichment_context` + `structural_tag_categories` (the classification guidance).
2. `research_search` with `phase2_status=pending` → get records that still need tags.
3. Reason about each record (use `research_get_record` for full text), then `research_enrich_record` to write its tags.

**Phase 3 — connect (judge records against a concept):**
1. `research_upsert_concept` → create/get the concept and its `id`.
2. `research_search` with `not_concept_id=<id>` → get records not yet checked against the concept.
3. Reason about relevance, then `research_connect_record` per record (`relevant=false` still marks it checked).
4. `research_record_concept_run` **once** at the end, for the domain just covered.

## Tools

| Tool | Method & path | Purpose |
|---|---|---|
| `research_list_domains` | `GET /api/research/domains` | Domains with `display_name`, `record_count`, `enrichment_context`, `structural_tag_categories`, `last_*_at`. Call first in Phase 2. |
| `research_search` | `GET /api/research/{domain}` | Compact record search. Params: `q`, `structural_tag`, `derived_tag`, `concept_id`, `not_concept_id`, `phase2_status`, `date_from`, `date_to`, `limit`, `offset`. |
| `research_get_record` | `GET /api/research/{domain}/{id}` | One full record (incl. full text). |
| `research_list_concepts` | `GET /api/research/concepts` | Existing concepts; optional `q`, `domain`. |
| `research_enrich_record` | `POST /api/research/{domain}/{id}/enrich` | Body `{ structural_tags: [{ tag, category, confidence }] }`. Phase 2 write. |
| `research_connect_record` | `POST /api/research/{domain}/{id}/connect` | Body `{ concept_id, concept_name, relevant, confidence, reasoning, specific_passage? }`. Phase 3 write. |
| `research_upsert_concept` | `POST /api/research/concepts` | Body `{ name, description? }` → returns the concept incl. `id`. |
| `research_record_concept_run` | `POST /api/research/concepts/{id}/record-run` | Body `{ domain }`. Call once at the end of a Phase 3 pass. |

### Relevant file paths
- Tool definitions / schemas: `A:\Projects\syncedsys\app\api\mcp\route.ts` (research section, immediately after the Library tools).
- Shared fetch helper: `A:\Projects\syncedsys\lib\research.ts` (`researchFetch`).
- Config: `RESEARCH_API_BASE_URL`, `RESEARCH_API_SECRET` in `.env.local` / `.env.local.example`.
