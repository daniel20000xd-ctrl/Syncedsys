# Syncedsys — Session Handoff

A Next.js 16 app. Supabase auth/DB (Postgres + RLS), Cloudflare R2 for blob storage, deployed on
Vercel at **syncedsys.com**. Repo: `daniel20000xd-ctrl/Syncedsys` (branch `main`, push
auto-deploys to Vercel).

> **2026-08-28 — frontend + MCP server intentionally deleted, mid-rewrite.** The backend
> (`app/actions.ts`, `lib/*` business logic, `supabase/*.sql`, every non-MCP `app/api/*` route) is
> untouched and fully functional. `components/`, all of `app/(app)/**`, `app/signup`, the MCP
> server (`app/api/mcp/**`, `lib/mcp*.ts`, `lib/cors.ts`, `docs/MCP_REFERENCE.md`) are gone. The
> frontend is being rebuilt from scratch, mode by mode, directly on `main` — with every UI
> feature routed through the backend deliberately (no ad-hoc wiring) this time. Sections below
> describe the **surviving backend only**; anything about canvas/board UI/Sidebar/Claude-on-canvas
> /MCP tools has been removed since that code no longer exists.
>
> **2026-09-01 — first two frontend pieces rebuilt: login + an admin-only scratch to-do page.**
> `app/globals.css` (Tailwind import) and `app/layout.tsx` are real again, not placeholder.
> `app/login/page.tsx` restores email/password + Google sign-in (from `lib/supabase/client.ts`,
> unchanged); **no `/signup`** — deliberately not restored, existing accounts only. `app/page.tsx`
> is a real auth gate: signed-out → `/login` (belt-and-suspenders; `proxy.ts` middleware already
> does this); signed-in non-admin → a static "nothing here yet" placeholder; signed-in admin
> (`isAdminEmail`, unchanged) → `components/TodoLists.tsx`, three renamable checklists. **This
> to-do feature is deliberately NOT wired to the backend** — no table, no server action, pure
> `localStorage` (`components/LogoutButton.tsx` is the only other new file, calls
> `supabase.auth.signOut()` directly). Do not "fix" it onto Supabase without being asked; that was
> an explicit requirement, not an oversight.
> `HANDOFF.md` was already stale before this and remains so — ignore it.

## Stack & conventions
- **Next.js 16.2.6** App Router + Turbopack, **React 19.2**. Middleware is **`proxy.ts`** exporting `proxy`
  (Next 16 rename of `middleware.ts`) → delegates to `lib/supabase/middleware.ts` `updateSession`.
- **Supabase SSR** (`@supabase/ssr`): `lib/supabase/client.ts` (browser), `server.ts` (server),
  `admin.ts` (service role / bypasses RLS), `authContext.ts` (AsyncLocalStorage JWT injection —
  was used by MCP; still fine to reuse for any future non-cookie auth path).
- **Cloudflare R2** via `@aws-sdk/client-s3` (`lib/r2.ts`): S3-compatible, bucket `syncedsys-storage`, all
  keys namespaced `{userId}/{app}/...`. Presigned GET URLs (1h) for reads. 2 GB/user cap (admins unlimited).
- **Tailwind v4** (`@import "tailwindcss"`) is still a dependency but `app/globals.css` was deleted with
  the frontend — re-add when the real root layout comes back. **@anthropic-ai/sdk** used by
  `app/api/claude/*` and `lib/claude/*`.
- All DB writes are **Server Actions in `app/actions.ts`** (`'use server'`) — ~80 of them, the primary API.
  This is the contract the new frontend should be built against.
- **Never** call `createClient()` at module/component top level — only in handlers/effects/async fns, or SSR prerender breaks.
- **Encryption**: `lib/crypto.ts` AES-256-GCM (payload `b64(iv).b64(tag).b64(ct)`), SHA-256 hashing, and
  `mintSupabaseUserJwt` (HS256). Needs **`APP_ENCRYPTION_KEY`** (32-byte base64) and **`SUPABASE_JWT_SECRET`**.
- **Frontend-only npm deps left installed but currently unused** (not pruned, since the rebuild may
  reuse them): `@dnd-kit/*`, `@xyflow/react`, `lucide-react`, `react-markdown`. `@modelcontextprotocol/sdk`
  is unused too (MCP server deleted) — remove when you're sure you won't rebuild MCP the same way.

### Tooling gotchas (Windows / PowerShell)
- A route group like the old `(app)` uses parens in the path — **use the Bash tool** (PowerShell chokes on parens) or quote paths, if you recreate one.
- A: drive is **slow**: never broad/recursive Glob there; use specific paths. Commit messages with parens/`@`/newlines → PowerShell here-string.
- `git push` over HTTPS prints to stderr; PowerShell shows it red even on success — check the last line (`main -> main`).
- **`npx next build` is the real check** (tsc alone misses some ESLint); keep build green. `npx tsc --noEmit` for fast iteration.

## Personas — top-level workspace layer (backend, no UI right now)
- A **persona is a board row with `is_persona=true` and `parent_id=NULL`** (the structural root). Existing top-level boards live **under** a persona.
- `lib/persona.ts` derives a board's persona by walking `parent_id` up to the `is_persona` root (`getPersonaId`, `isInPersona`). Null persona = legacy pre-migration boards.
- `createPersona()`/`deletePersona()` in `app/actions.ts`; `deletePersona()` deletes the whole subtree and refuses to drop the last persona.
- **`supabase/personas.sql`**: adds `boards.is_persona`, a `persona_is_root` CHECK, a trigger blocking deletion of non-empty personas, and a one-time backfill that wraps orphaned top-level boards in a "Personal" persona. Idempotent.

## Board modes (`boards.mode`, default `'classic'`) — data model only, no renderers exist yet
- Values seen in the DB: `'classic'`/`'free'` (freeform canvas), `'trello'` (kanban), `'folder'` (file explorer), `'database'` (admin-only reference library). All the renderers for these were deleted with the frontend; the mode value itself and its server actions in `app/actions.ts` still work.
- **`'text'` mode (DocTabs notetaking) was removed entirely on 2026-08-28** — not just the renderer. `lib/doctabs.ts` and `lib/docTabsStore.ts` are deleted, the mode value is stripped from every type union/tool schema/context renderer, and all 10 existing `mode='text'` boards + their content were hard-deleted from the DB (user-confirmed, no export). Canvas `type='text'` elements (free-floating text notes) were removed the same way — the `create_text` Claude tool is gone and the 26 existing rows were deleted (plus 5 board_edges that referenced them). Do not reintroduce either without being asked.
- Boards self-reference via `parent_id` + `tab_position` (infinite nesting; sub-tabs are just child boards). Soft groupings via `group_id` + `is_group` (max 2 levels; deleting a group nulls members' `group_id`, never deletes children).

## Claude backend (billing/context/tools) — `app/api/claude/route.ts`, `lib/claude/*`
- **`app/api/claude/route.ts`** — POST `{ boardId, messages }`; resolves key → gate → builds context → agentic loop (**max 8 turns**), streaming `text`/`tool`/`tool_result`/`error`/`done`. Records usage at the end (even on error). No frontend chat UI exists right now — this route is intact and callable directly.
- **Key resolution (`lib/claude/key.ts`)**: user's own stored key (`user_secrets.anthropic_key_encrypted`, AES-GCM) → `keySource:'user'` (**never billed**); else the **platform `ANTHROPIC_API_KEY`** → `keySource:'platform'` (metered). Own-key requests **bypass the gate entirely**.
- **Gate (`lib/claude/gate.ts`)**: global kill switch via env `CLAUDE_API_ENABLED=false` or `app_config` row; platform-key users capped at a free allowance (`CLAUDE_FREE_ALLOWANCE_USD`, default $0.50/mo raw) unless they opt into `claude_pay_per_use`. Admins uncapped. Soft cap is checked pre-run (can slightly overshoot).
- **Usage ledger (`lib/claude/usage.ts` + `supabase/claude_usage.sql`)**: append-only **`claude_usage`** table (`model, key_source, billable, input/output/cache tokens, cost_usd (raw), turns, board_id, errored`). **Service-role INSERT only — RLS makes it read-only to users; do NOT regress that.** `lib/claude/pricing.ts` prices Sonnet 4.5 / Haiku 4.5; `billableUsd = max(0, raw − freeAllowance) × CLAUDE_MARKUP`.
- **Context (`lib/claude/context.ts`)**: **scope = BFS down** from the board through children + portal/folder-link targets (never up; persona boards excluded). Renders board tree + text/kanban content + PDF excerpts + live-fetched portal data between `---BEGIN/END … DATA---` markers. Server-validates every write `boardId` against the allowed set.
- **Tools (`lib/claude/tools.ts`, ~860 lines)**: READ tools always on. WRITE tools are only exposed when writes are enabled — own-key always, platform-key only if **`claude_auto_apply`** is set.
- **`lib/claude/suggestBoardMeta.ts`** — small Haiku helper (moved out of the deleted MCP file, still used by `app/api/boards/suggest-meta/route.ts`).

## MCP server — deleted, to be rebuilt
Previously exposed 60+ tools at `app/api/mcp/route.ts` (+ `lib/mcpAuth.ts`/`mcpOauth.ts`/`lib/cors.ts`,
OAuth PKCE flow, PAT auth via `mcp_tokens`) so external Claude clients could drive the workspace. All
of that code is gone. `supabase/mcp_setup.sql`/`mcp_oauth.sql` still define the `mcp_tokens` /
`snapshots` / `claude_actions` tables (now dead schema, not deleted — no data-loss risk, just unused
until MCP is rebuilt).

## Google integration — `lib/google/*`, `app/api/google/*` (backend intact, portals deleted)
- **OAuth**: `connectGoogleAccount()` → consent (scopes: identity `openid/email/profile` + `calendar`, `spreadsheets`, `documents`, `drive.readonly`; `access_type=offline&prompt=consent`). Callback exchanges code; access+refresh tokens stored **AES-GCM-encrypted** in **`user_google_tokens`** (service-role writes, RLS owner-read). `lib/google/client.ts` `googleFetch` injects the token and force-refreshes on 401 (60s skew). `supabase/google_oauth.sql`.
- **Services**: `calendar.ts` (list/CRUD events), `docs.ts` (read + render-to-HTML + batchUpdate writes), `sheets.ts` (read/write ranges, metadata, formatting, batch structural), `drive.ts` (file picker). Each `*/context` route returns **plain-text** summaries for Claude (capped).
- **Env**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (`…/api/google/callback`).

## PDFs, files & folders (backend helpers, no drop-UI right now)
- `lib/pdf.ts`: `extractPdfText` (pdfjs CDN worker, 120k cap), `uploadPdf` (R2), `renderPdfThumbnail`. `getPdfUrl(key)` mints a 1h presigned URL. Element type `'pdf'`, data `{ name, storagePath, text, pageCount }`.
- `lib/files.ts` parses a drop into `{trees, files, pdfs, skipped}`; `importFolderTree` recreates a dropped folder as a board tree. Text files store to R2 (`createTextFile`/`updateTextFile`).

## Photo library — `app/api/photos/*` (backend intact, `/photos` + `/admin/photos` UI deleted)
- iOS companion app POSTs to `/api/photos/upload` with `Authorization: Bearer COMPANION_APP_SECRET` (resolves to the admin user). Validates mime/size (≤20 MB), extracts dimensions, stores bytes in **R2** (`workspace-photos/{userId}/{uuid}.ext`), inserts a **`workspace_photos`** row with `expires_at = now + 7d`.
- **Auto-deletion**: the daily cron deletes unsaved expired photos unless the user marked them saved (`is_saved=true` → `expires_at=null`) or globally paused (`photo_library_settings.pause_deletion`). Reads use 1h signed URLs, downloads 24h.
- `supabase/workspace_photos.sql` (+ `_v2.sql` adds `description` and the `photo_library_settings` table).

## Library & Database mode — `app/api/library/*`, `fetch-cases.ts` (backend intact, `DatabaseBoardView` UI deleted)
- A personal **legal-research / papers** library (`library_items`: `type legal_case|paper`, title, summary, tags[], `metadata` jsonb, `full_text`, `content_hash`, `verified`, soft-`deleted`, + a generated **Swedish `tsvector`** for full-text search).
- **Routes**: `/api/library/ingest` (Bearer `LIBRARY_INGEST_KEY` or session; upsert by `metadata.beteckning` for cases / `doi` for papers), `/api/library/search` (Postgres `textSearch` config `swedish`, filters/sort), `/api/library/item/[id]` (full record). Actions: `updateLibraryItem`, `deleteLibraryItem`.
- **`fetch-cases.ts`** (root CLI) scrapes Swedish case law from the Domstolsverket API (`rattspraxis.etjanst.domstol.se`), keyword sets from **`vocabulary.json`** (arv/patent/migration topics), writes to `~/library_staging/`, then you POST to the ingest endpoint. Schema lives at the bottom of `schema.sql`.

## url_preview unit (backend intact, no canvas UI right now)
- `POST /api/units/url-preview` validates (SSRF-safe) → inserts a `pending` row → `enrichUrl` (`lib/urlPreview.ts`) fetches HTML (8s/3MB caps, redirect-validated), scrapes OG tags via `open-graph-scraper`, **re-hosts og:image to R2**, updates the element. `/api/units/url-preview/enrich` self-heals stuck `pending` units. Client-safe helpers in `lib/urlPreviewShared.ts`. Action: `createUrlPreview`.

## Export
- **Markdown** (`lib/exportBoard.ts`): render a board's soft units (lists+cards/url-previews) to `.md` with sanitized filenames. **ZIP** (`lib/exportZip.ts` via `fflate`): whole subtree as a folder tree — batched level-order BFS (no N+1), R2 blobs resolved through a 6-worker pool with size guards (50 MB/object, 150 MB total, 5000 entries). Served by `POST /api/boards/download`.
- `/api/boards/meta` lists boards; `/api/boards/suggest-meta` AI-suggests a board description (Haiku, gated + metered).

## Stock Viewer (satellite)
- Full viewer is a **satellite app** at `stocks.syncedsys.com` (repo `daniel20000xd-ctrl/stocks.syncedsys`). Hub role is minimal: **`/api/stocks`** thin proxy (auth-checks caller, forwards with cookies to `STOCKS_API_URL`, 503 if unreachable). `stocks_enabled` flag lives in **`user_metadata`** (no migration) via `get/setStocksEnabled` — no UI to toggle it right now.

## iOS sync
- **`/api/sync`**: `Authorization: Bearer <token>` → paired `device_links` row → returns **ALL** that user's boards + lists/cards/elements. `force-dynamic` + `no-store` (Vercel was edge-caching it). **All boards sync by default**; `boards.synced=false` is an **opt-OUT** (`setBoardSynced`).
- **`/api/devices/pair`** — body `{ code, name? }` marks the unpaired `device_links` row paired → `{ token, deviceId, userId }`. No UI to manage codes right now (`createDeviceLink`/`removeDeviceLink` actions still exist). The iOS app is not in this repo.

## Storage, limits, cron, admin
- **Limits (`lib/limits.ts`)**: free users = 2 GB R2 + `CLAUDE_FREE_ALLOWANCE_USD`; **admins = unlimited** (`isAdminEmail`). `getStorageUsage()` scans R2 by app.
- **Cron (`vercel.json`)**: `/api/cron/cleanup` daily 02:00 (delete expired boards/lists/cards/elements; reset due recurring cards via `lib/recur.ts`); `/api/cron/cleanup-photos` daily 03:00. Both gated by **`CRON_SECRET`** bearer.
- **Admin**: `ADMIN_EMAIL` env (case-insensitive, `lib/admin.ts`). No admin console UI right now. `getAdminClaudeBilling()` (service-role) aggregates per-user spend for invoicing.

## Gate / desktop (new, undocumented before this pass)
- `app/api/gate/{request,action}/route.ts` + `supabase/gate.sql` (`gate_requests` table, anonymous-insert RLS) — a decoy-site access-request ingestion flow, gated by `GATE_SECRET` header (see `.env.local.example`).
- `app/api/desktop/token-exchange/route.ts` — exchanges a paired device's long-lived bearer token for a 30-day Supabase JWT via `createAdminClient()` + `mintSupabaseUserJwt`.

## Environment / deploy
Vercel env vars (`.env.local` mirrors; **`.env.local.example` is incomplete** — this list supersedes it):
- **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, **`SUPABASE_JWT_SECRET`** (mint user JWTs).
- **Core**: `ADMIN_EMAIL` (=`Daniel20000xd@gmail.com`), **`APP_ENCRYPTION_KEY`** (AES-256-GCM, required for Claude/Google key encryption + OAuth codes).
- **Claude billing**: `ANTHROPIC_API_KEY` (platform key), `CLAUDE_MARKUP` (default 1.0), `CLAUDE_FREE_ALLOWANCE_USD` (default 0.5), `CLAUDE_API_ENABLED` (kill switch).
- **R2**: `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (default `syncedsys-storage`).
- **Google**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- **Other**: `COMPANION_APP_SECRET` (iOS photo upload), `CRON_SECRET` (Vercel cron auth), `LIBRARY_INGEST_KEY` (fetch-cases ingest), `STOCKS_API_URL` (default `https://stocks.syncedsys.com`), `NEXT_PUBLIC_STORAGE_URL`, `GATE_SECRET` (decoy-site gate).

## ⚠️ DB MIGRATION STATE — READ FIRST
The live Supabase DB was created from an early schema and is repeatedly missing newer pieces; **the user adds them by hand**. Before debugging "X doesn't save / disappears on reload", confirm the column/table/bucket exists. Migration SQL is split across **`supabase/*.sql`** — apply the relevant file(s):
- **`schema.sql`** (447 lines) — base: `boards, lists, cards, board_edges, board_elements, device_links, account_links, user_secrets, snapshots, claude_actions, claude_usage, app_config, library_items (+ Swedish tsv), mcp_tokens`. Idempotent `alter … add column if not exists` upgrades are inline; the **Stock Viewer `stocks_enabled` + `stock_cache`** block is still **commented at the bottom** (apply by hand if needed — `/api/stocks` try/catches around the cache).
- **`claude_usage.sql`** — append-only usage ledger + `app_config` kill switch (service-role writes only).
- **`google_oauth.sql`** — `user_google_tokens` (encrypted tokens, service-role writes).
- **`mcp_setup.sql`** — `mcp_tokens` + `snapshots` + `claude_actions` (dead schema now MCP server is gone — harmless, keep). **`mcp_oauth.sql`** — `mcp_oauth_codes` (currently unused; codes were stateless).
- **`personas.sql`** — `boards.is_persona` + constraint + trigger + backfill.
- **`workspace_photos.sql`** (+ **`_v2.sql`**: `description`, `photo_library_settings`).
- **`gate.sql`** — `gate_requests` table for the decoy-site gate (untracked as of this pass — apply by hand if you haven't).
- **No migration needed**: `stocks_enabled` (in `user_metadata`); active persona (was localStorage, frontend-only concept).

## Known gaps / next tasks
- **The entire frontend and MCP server need rebuilding.** See the status note at the top of this file for what's gone and why.
- **Library full_text search is Postgres FTS only** (Swedish `tsvector`), no semantic/vector search. `fetch-cases.ts` ingest is two-stage/manual.
- `account_links` (linked-account backend) has no UI right now.
- In-app Claude model is `claude-sonnet-4-5`; consider bumping to current Sonnet/Opus when revisiting `lib/claude/*`.

## Key files
- **Data layer**: `app/actions.ts` (~80 server actions — the primary API, and the contract the new frontend should be built against), `lib/types.ts`, `supabase/*.sql`.
- **Claude**: `app/api/claude/route.ts`, `lib/claude/{context,tools,key,gate,usage,pricing,suggestBoardMeta}.ts`, `lib/claudeDropRegistry.ts`, `lib/crypto.ts`.
- **Google**: `lib/google/*`, `app/api/google/*`.
- **Storage/photos/library**: `lib/r2.ts`/`limits.ts`/`pdf.ts`/`files.ts`/`exportBoard.ts`/`exportZip.ts`/`urlPreview.ts`, `app/api/photos/*`, `app/api/library/*`, `fetch-cases.ts`.
- **Shell (placeholder)**: `app/layout.tsx`, `app/page.tsx` — throwaway, replace when rebuilding the real frontend.
