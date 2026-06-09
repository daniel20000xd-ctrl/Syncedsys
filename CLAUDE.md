# Syncedsys — Session Handoff

A Next.js 16 personal workspace: a **freeform canvas** (Trello/text/folder/database modes too) with an
**on-canvas Claude assistant**, a **full MCP server** (so external Claude clients can drive the workspace),
**Google Calendar/Docs/Sheets/Slides** integration, **personas**, a **photo library**, a **legal-research
library**, PDF support, and an embedded **Stock Viewer**. Supabase auth/DB (Postgres + RLS), Cloudflare R2
for blob storage, deployed on Vercel at **syncedsys.com**. Repo: `daniel20000xd-ctrl/Syncedsys` (branch
`main`, push auto-deploys to Vercel). Several features live in **satellite apps** on subdomains
(stocks./slides./text./storage.syncedsys.com).

> This file is the source of truth. It was substantially behind the code as of 2026-06; it now reflects the
> personas / MCP / Google / photos / library / billing work. The older `HANDOFF.md` is **stale** (still
> describes the in-repo Stock Viewer and a spreadsheet mode that no longer exist) — trust this file.

## Stack & conventions
- **Next.js 16.2.6** App Router + Turbopack, **React 19.2**. Middleware is **`proxy.ts`** exporting `proxy`
  (Next 16 rename of `middleware.ts`) → delegates to `lib/supabase/middleware.ts` `updateSession`.
- **`next.config.ts` has rewrites** mapping `/.well-known/oauth-*` → `/api/mcp/oauth/*` (MCP OAuth discovery)
  and sets `experimental.staleTimes` (dynamic 30s) so revisited board tabs serve from router cache.
- **Supabase SSR** (`@supabase/ssr`): `lib/supabase/client.ts` (browser), `server.ts` (server),
  `admin.ts` (service role / bypasses RLS), `authContext.ts` (AsyncLocalStorage JWT injection for MCP).
- **Cloudflare R2** via `@aws-sdk/client-s3` (`lib/r2.ts`): S3-compatible, bucket `syncedsys-storage`, all
  keys namespaced `{userId}/{app}/...`. Presigned GET URLs (1h) for reads. 2 GB/user cap (admins unlimited).
- **@dnd-kit** for Trello drag/drop. **@xyflow/react** v12 for the freeform "classic" canvas.
- **Tailwind v4** (`@import "tailwindcss"`). **lucide-react** icons. **@anthropic-ai/sdk** + **@modelcontextprotocol/sdk**.
- All DB writes are **Server Actions in `app/actions.ts`** (`'use server'`) — ~80 of them, the primary API.
- **Never** call `createClient()` at module/component top level — only in handlers/effects/async fns, or SSR prerender breaks.
- **`dynamic(() => ..., { ssr: false })` must live in a Client Component**, never a Server Component. Pattern: a thin `'use client'` default-import wrapper (e.g. `DatabaseBoardViewWrapper.tsx`).
- Floating panels use `createPortal` so the `overflow-x-auto` tab bars don't clip them.
- **Encryption**: `lib/crypto.ts` AES-256-GCM (payload `b64(iv).b64(tag).b64(ct)`), SHA-256 hashing, and
  `mintSupabaseUserJwt` (HS256). Needs **`APP_ENCRYPTION_KEY`** (32-byte base64) and **`SUPABASE_JWT_SECRET`**.

### Tooling gotchas (Windows / PowerShell)
- Route-group paths contain `(app)` parens — **use the Bash tool** (PowerShell chokes on parens) or quote paths.
- A: drive is **slow**: never broad/recursive Glob there; use specific paths. Commit messages with parens/`@`/newlines → PowerShell here-string.
- `git push` over HTTPS prints to stderr; PowerShell shows it red even on success — check the last line (`main -> main`).
- **`npx next build` is the real check** (tsc alone misses some ESLint); keep build green. `npx tsc --noEmit` for fast iteration.

## App shell & routing
- `app/layout.tsx` — root HTML shell, `globals.css`.
- `app/page.tsx` — auth gate: signed-out → `/login`; signed-in → first persona's first board (seeds a starter board with two linked sticky notes for brand-new users); no persona → `/boards`.
- `app/(app)/layout.tsx` — the authenticated shell: auth guard, fetches all boards + device links, mounts **Sidebar + TabBar + SubTabBar** around the page. Admin gate via `isAdminEmail(jwt.email)`.
- `app/(app)/board/[id]/page.tsx` — **mode dispatcher**: `classic`/`free` → `FreeBoardView` (bare); `trello` → `BoardView`, `text` → `TextBoardView`, `folder` → `FolderBoardView`, `database` → `DatabaseBoardViewWrapper` (each wrapped in `BoardDesktop`). A persona board redirects to its first child. Mounts `ClaudeAgent` when Claude is available.
- `app/(app)/boards/page.tsx` → `BoardsHome` (persona-scoped recursive board grid + create/delete/properties).
- `app/(app)/settings/*`, `app/(app)/admin/*` (admin console + `admin/photos`), `app/(app)/overview` (legacy all-users board list), `app/(app)/photos`.
- `app/login`, `app/signup`, `app/auth/callback` (Supabase), `app/api/google/callback`, plus MCP OAuth routes (see MCP).

## Personas — top-level workspace layer
- A **persona is a board row with `is_persona=true` and `parent_id=NULL`** (the structural root). Existing top-level boards live **under** a persona. Switching persona changes which board subtree you see.
- Active persona is client-side: **`localStorage.activePersonaId`**. Most board-creating actions take `activePersonaId` so new boards land in the right persona.
- `lib/persona.ts` derives a board's persona by walking `parent_id` up to the `is_persona` root (`getPersonaId`, `isInPersona`). Null persona = legacy pre-migration boards.
- `createPersona()` makes the persona **plus a default child board**; `deletePersona()` deletes the whole subtree and refuses to drop the last persona. UI: `components/PersonaSettings.tsx` (in Settings) + the avatar switcher in the tab UI.
- **`supabase/personas.sql`**: adds `boards.is_persona`, a `persona_is_root` CHECK, a trigger blocking deletion of non-empty personas, and a one-time backfill that wraps orphaned top-level boards in a "Personal" persona. Idempotent.
- **Claude/MCP never see persona boards** — they're excluded from assistant scope (a persona is a divider, not content).

## Board modes (`boards.mode`, default `'classic'`)
- **`'classic'`** = freeform canvas (xyflow). **The default.** → `components/free/FreeBoardView.tsx`. Legacy `'free'` aliases here.
- **`'trello'`** = kanban columns. → `components/BoardView.tsx` (+ `KanbanList`, `CardItem`).
- **`'text'`** = document with **DocTabs** (multiple pages), autosaves to `boards.content`. → `components/TextBoardView.tsx`.
- **`'folder'`** = file explorer (sub-folders + dropped files of any type). → `components/FolderBoardView.tsx`.
- **`'database'`** = **admin-only** reference library (legal cases / papers). → `DatabaseBoardView`. (Replaced the old spreadsheet mode — `SpreadsheetBoardView`/`lib/spreadsheet.ts` are **gone**; sheets now live in the Google Sheets portal.)
- `text`/`database` modes are locked after creation. `NewBoardModal` offers Canvas/Kanban/Document/Folder; the on-canvas `SubtabModePicker` additionally offers Database for admins.

## Tabs & sub-tabs
- `components/TabBar.tsx` — browser-style tabs (a persona's root boards). Drag-reorder is **optimistic** (local `setBoards` → `moveTab` action → `router.refresh()`).
- `components/SubTabBar.tsx` — stacked rows under the main tabs (ancestor chain).
- `components/BoardPropertiesPanel.tsx` — shared panel: name, color, expiry, mode, **"Sync to iOS" toggle**, Add sub-tab, Remove tab. Calls `router.refresh()` on save.
- Boards self-reference via `parent_id` + `tab_position` (infinite nesting; sub-tabs are just child boards). Soft groupings via `group_id` + `is_group` (max 2 levels; deleting a group nulls members' `group_id`, never deletes children).

## Free-mode canvas — `components/free/FreeBoardView.tsx` (~2900 lines) + `nodes.tsx` (~2000 lines)
Toolbar (top-right, vertical, icon-only): **Undo · Redo │ Select(V) · Hand(H) · Draw(P) · Shape(R) · Text(T) · Portal(F) · Claude(C)**.
- **Select**: left-drag = marquee multi-select; Delete removes selection; middle/right-drag pans. Recolor swatches appear when shapes/drawings/text are selected.
- **Draw / Shape / Text / Portal / Claude**: pointer overlay (`overlayActive`) intercepts input. Shape/Portal/Claude = press-drag-release box (live dashed preview, `beginBoxDraw`/`commitBoxDraw`). Shapes: rect/circle/arrow. Text = click to drop.
- **Right-click empty canvas** → context menu (list/card/sub-tab/image/draw/shape). **Add sub-tab** opens the `SubtabModePicker` mode modal first.
- **Hold a unit + scroll = resize it** (NOT zoom) — capture-phase wheel listener; shapes/portals resize w/h, others scale `data.scale`. Persists on mouseup.
- **Undo `Ctrl+Z` / Redo `Ctrl+X`** (+ toolbar buttons): debounced snapshot history; reconciles DB via `upsertElement` (client-generated UUIDs). `elTypeOf` maps node types incl. `pdfNode→'pdf'`, `claudeNode→'claude'`, `urlPreviewNode→'url_preview'`.
- **`nodeTypes` registry**: `listNode, cardNode, shapeNode, imageNode, drawingNode, subTabNode, textNode, textFileNode, folderLinkNode, portalNode, claudeNode, pdfNode, urlPreviewNode`. **`edgeTypes`**: `deletable: DeletableEdge`.
- **Links (edges)**: 4 side handles per node, `ConnectionMode.Loose`. Handles invisible until cursor is near (JS proximity → inline `opacity`; `.rf-connecting` pulses all handles during a drag). Hover a link → bend dot + colour + × delete; drag to bend (quadratic, persisted in `board_edges.data {cx,cy}`).
- **`scheduleRefresh()`** debounces `router.refresh()` at **250 ms**.
- **Alignment guides**: wrapped `onNodesChange` runs the React-Flow "helper-lines" pattern — single-node drag snaps within ~10 screen-px (zoom-aware) to other nodes' edges/centers; pink guide lines span the board while dragging. Pure module-level `computeGuides()`/`getNodeWH()`.
- **Grouping (drop into shapes)**: containers are `shapeNode`s; drag any node onto a shape → child (`data.parentId`, green dashed ring). Moving a container moves descendants; resizing (hold+scroll or `NodeResizer` corner) scales them. Detach by dragging out. Transitive + cycle-safe. Child→parent map in **`localStorage` `groupmap-<boardId>`** (zero-schema, like z-order `zmap-<boardId>`). Lives entirely in `FreeBoardView` in absolute coords — deliberately NOT React Flow's native `parentId`/`extent`.

## Portals & built-in Viewers — `PortalNode` in `nodes.tsx`
A resizable window showing a live view of **another board** or a built-in **Viewer**. The ⌄ chooser is split **Viewers** vs **Tabs** (mutually exclusive: picking a viewer sets `data.viewerKind`/`viewerConfig` + clears `targetBoardId`).
- **Viewer kinds**: `stocks` (`StockPortal`), `slides` (`SlidesPortal`), `google-calendar` (`GoogleCalendarPortal`), `google-docs` (`GoogleDocsPortal`), `google-sheets` (`GoogleSheetsPortal`), `text` (`TextPortal`).
- **Board portals**: render the target's lists/cards/shapes/text/drawings/images + links; plain scroll = pan, Ctrl/⌘+scroll = zoom (inside the portal). Auto-fit once; **Lock** freezes pan/zoom; text/folder targets render their own previews. Auto-mirror via `ensureMirrorPortal`.
- Element type `'portal'`; `data = { targetBoardId, home, vx, vy, zoom, locked, fitted, width, height, viewerKind?, viewerConfig?, viewer_context? }`. `persist()` carries viewer fields + `viewer_context` forward on every pan/zoom/resize. `viewer_context` is the plain-text snapshot Claude reads (zero-loss).

## Sidebar & dashboards
- `components/Sidebar.tsx` — collapsible nav hub. Top half (per active board): **UnitsPanel** (canvas units), **DocTabsPanel** (text-mode pages), **FolderUnitsPanel** (folder items), or the board's list names as fallback. Footer: **Admin Console** (admins → `/admin`), **Photo Library** (`/photos`), **Settings**, **Log out**.
- `lib/unitsStore.ts` — module store bridging canvas ↔ sidebar via `useSyncExternalStore` (`select/reorder/setOpacity/setHidden/rename`; `Unit.mode` carries sub-tab board mode). `components/UnitsPanel.tsx`: click→select, drag→layer order (`data.z` + zmap), gear→opacity, eye→hide, double-click→inline rename. Sibling stores: `lib/docTabsStore.ts` + `lib/doctabs.ts` (DocTabs serialize into `boards.content` JSON, legacy raw content = "Page 1"), `lib/folderUnitsStore.ts`.

## Claude on the canvas + platform billing — `components/claude/`, `lib/claude/`
- **`ClaudeNode`** (in `nodes.tsx`) = resizable on-canvas chat with a "claude orange" neon glow. **`ClaudeAgent.tsx`** = the floating bottom-right panel. **`ClaudeChat.tsx`** = chat UI; SSE stream from `app/api/claude/route.ts`; dropped files/PDFs become **attachment chips** injected via the module-level **`lib/claudeDropRegistry.ts`** (no prop-drilling). `ClaudeMark.tsx` = the coral sunburst logo.
- **`app/api/claude/route.ts`** — POST `{ boardId, messages }`; resolves key → gate → builds context → agentic loop (**max 8 turns**), streaming `text`/`tool`/`tool_result`/`error`/`done`. Records usage at the end (even on error).
- **Key resolution (`lib/claude/key.ts`)**: user's own stored key (`user_secrets.anthropic_key_encrypted`, AES-GCM) → `keySource:'user'` (**never billed**); else the **platform `ANTHROPIC_API_KEY`** → `keySource:'platform'` (metered). Own-key requests **bypass the gate entirely**.
- **Gate (`lib/claude/gate.ts`)**: global kill switch via env `CLAUDE_API_ENABLED=false` or `app_config` row; platform-key users capped at a free allowance (`CLAUDE_FREE_ALLOWANCE_USD`, default $0.50/mo raw) unless they opt into `claude_pay_per_use`. Admins uncapped. Soft cap is checked pre-run (can slightly overshoot).
- **Usage ledger (`lib/claude/usage.ts` + `supabase/claude_usage.sql`)**: append-only **`claude_usage`** table (`model, key_source, billable, input/output/cache tokens, cost_usd (raw), turns, board_id, errored`). **Service-role INSERT only — RLS makes it read-only to users; do NOT regress that.** `lib/claude/pricing.ts` prices Sonnet 4.5 / Haiku 4.5; `billableUsd = max(0, raw − freeAllowance) × CLAUDE_MARKUP`.
- **Models**: in-app chat = `claude-sonnet-4-5-20250929`; `find_relevant_boards`/`suggest_board_meta` use Haiku 4.5.
- **Context (`lib/claude/context.ts`)**: **scope = BFS down** from the board through children + portal/folder-link targets (never up; persona boards excluded). Renders board tree + text/kanban content + PDF excerpts + **live-fetched portal data** (Google Docs/Sheets/Calendar, Slides satellite, generic `viewer_context`) between `---BEGIN/END … DATA---` markers. Server-validates every write `boardId` against the allowed set.
- **Tools (`lib/claude/tools.ts`, ~860 lines)**: READ tools always on (`get_board`, Google read, Sheets/Docs read). WRITE tools (create board/list/card/text/shape/file/url_preview, `set_board_content`, Google Calendar/Sheets/Docs mutations, Slides ops) are only exposed when **writes are enabled** — own-key always, platform-key only if **`claude_auto_apply`** is set. When off, write tools are omitted from the tool list entirely.
- **Settings UI**: `ClaudeKeySettings` (save/remove key, auto-apply toggle), `ClaudeUsageCard` (spend bar, pay-per-use opt-in), `ClaudeApiSwitch` (admin kill switch).

## The MCP server — `app/api/mcp/route.ts` (~1300 lines) + `lib/mcp*.ts`
Lets **external Claude clients (claude.ai, Claude Desktop, Claude Code)** drive the whole workspace as the user, no Anthropic key needed. Exposes **60+ tools** (the deferred `mcp__1eecd153-…__*` tools in this session) — boards/lists/cards/elements/edges CRUD, sub-tabs, portals, devices, library, photos, settings, account links. Every write snapshots the prior state (`snapshots`) and logs to `claude_actions`.
- **Auth (`lib/mcpAuth.ts`)**: two paths converge on a user JWT injected via **`AsyncLocalStorage`** so Server Actions run under that user's RLS:
  1. **PAT** — `Authorization: Bearer sk_ssys_<hex>`; SHA-256 hash looked up in **`mcp_tokens`** (plaintext never stored); per-token rate limit 120/min stored in the row. Mints a user JWT via `SUPABASE_JWT_SECRET`.
  2. **Same-origin session cookie** — uses the live Supabase session.
- **OAuth 2.0 PKCE (`lib/mcpOauth.ts`)** so claude.ai can connect: discovery (RFC 8414) + protected-resource (RFC 9728) + dynamic registration (RFC 7591) + authorize + token. Routes exist at both `/api/mcp/oauth/*` and root (`/authorize`, `/token`, `/register`, `/.well-known/...`) because clients probe both; `next.config.ts` rewrites wire the well-known paths. **Authorization codes are stateless** (AES-GCM-encrypted payload, 10-min TTL, PKCE-verified) — no DB row needed (`mcp_oauth.sql` table is unused). Token exchange mints a PAT. CORS is open on OAuth endpoints (`lib/cors.ts`). The user must be **logged into the web app** to approve.
- **Settings UI**: `components/McpConnectSettings.tsx` shows the endpoint + `claude mcp add` command and manages PATs (`createMcpToken`/`listMcpTokens`/`revokeMcpToken`).
- **Reference**: `docs/MCP_REFERENCE.md` (126 KB, full tool catalog — don't read whole).

## Google integration — `lib/google/*`, `app/api/google/*`
- **OAuth**: `connectGoogleAccount()` → consent (scopes: identity `openid/email/profile` + `calendar`, `spreadsheets`, `documents`, `drive.readonly`; `access_type=offline&prompt=consent`). Callback exchanges code; access+refresh tokens stored **AES-GCM-encrypted** in **`user_google_tokens`** (service-role writes, RLS owner-read). `lib/google/client.ts` `googleFetch` injects the token and force-refreshes on 401 (60s skew). `supabase/google_oauth.sql`.
- **Services**: `calendar.ts` (list/CRUD events), `docs.ts` (read + render-to-HTML + batchUpdate writes), `sheets.ts` (read/write ranges, metadata, formatting, batch structural), `drive.ts` (file picker). Each `*/context` route returns **plain-text** summaries for Claude (capped).
- **On-canvas portals**: `GoogleCalendarPortal` (month/week/day, create/edit/drag), `GoogleDocsPortal` (viewer + Drive picker + append/replace), `GoogleSheetsPortal` (virtualized editable grid + formatting + structural ops). All are portal `viewerKind`s that persist config and push `viewer_context`.
- **Satellite portals**: `SlidesPortal` (iframes `slides.syncedsys.com`), `TextPortal` (iframes `text.syncedsys.com/board/{id}`) — both pass Supabase tokens, exchange config via postMessage. `components/DocTabsPanel.tsx` drives the text-mode page tabs.
- **Env**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (`…/api/google/callback`). UI: `GoogleAccountSettings.tsx`.

## PDFs, files & folders
- Drop a PDF on the canvas/folder → a **`pdfNode`** (opens the stored PDF). Drop near a Claude node → chat attachment; near a sub-tab → lands in that board. `lib/pdf.ts`: `extractPdfText` (pdfjs CDN worker, 120k cap), `uploadPdf` (R2), `renderPdfThumbnail`. `getPdfUrl(key)` mints a 1h presigned URL. Element type `'pdf'`, data `{ name, storagePath, text, pageCount }`.
- **Any file type** can be dropped → opaque `'file'` / `'textfile'` units in folder/canvas mode (`lib/files.ts` parses a drop into `{trees, files, pdfs, skipped}`; `importFolderTree` recreates a dropped folder as a board tree). Text files store to R2 (`createTextFile`/`updateTextFile`).
- Drop routing uses **magnetic targeting** (`MAGNETIC_RADIUS`, pulsing ring): Claude chat vs sub-tab vs canvas.

## Photo library — `app/api/photos/*`, `app/(app)/photos`, `app/(app)/admin/photos`
- iOS companion app POSTs to `/api/photos/upload` with `Authorization: Bearer COMPANION_APP_SECRET` (resolves to the admin user). Validates mime/size (≤20 MB), extracts dimensions, stores bytes in **R2** (`workspace-photos/{userId}/{uuid}.ext`), inserts a **`workspace_photos`** row with `expires_at = now + 7d`.
- **Auto-deletion**: the daily cron deletes unsaved expired photos unless the user marked them saved (`is_saved=true` → `expires_at=null`) or globally paused (`photo_library_settings.pause_deletion`). User page `/photos` (save/describe/download/delete + pause toggle); admin grid `/admin/photos` (bulk select/delete). Reads use 1h signed URLs, downloads 24h.
- `supabase/workspace_photos.sql` (+ `_v2.sql` adds `description` and the `photo_library_settings` table). MCP exposes `get_workspace_photos`/`get_photo_image`/`update_workspace_photo`/`get|set_photo_settings`.

## Library & Database mode — `app/api/library/*`, `DatabaseBoardView`, `fetch-cases.ts`
- A personal **legal-research / papers** library (`library_items`: `type legal_case|paper`, title, summary, tags[], `metadata` jsonb, `full_text`, `content_hash`, `verified`, soft-`deleted`, + a generated **Swedish `tsvector`** for full-text search). Admin-only; rendered by the **`database`** board mode (search, filter, tag/verify edit).
- **Routes**: `/api/library/ingest` (Bearer `LIBRARY_INGEST_KEY` or session; upsert by `metadata.beteckning` for cases / `doi` for papers), `/api/library/search` (Postgres `textSearch` config `swedish`, filters/sort), `/api/library/item/[id]` (full record). Actions: `updateLibraryItem`, `deleteLibraryItem`.
- **`fetch-cases.ts`** (root CLI) scrapes Swedish case law from the Domstolsverket API (`rattspraxis.etjanst.domstol.se`), keyword sets from **`vocabulary.json`** (arv/patent/migration topics), writes to `~/library_staging/`, then you POST to the ingest endpoint. Schema lives at the bottom of `schema.sql`.

## url_preview unit
- Pasting a URL / an MCP or Claude tool → a `url_preview` canvas element. `POST /api/units/url-preview` validates (SSRF-safe) → inserts a `pending` row → `enrichUrl` (`lib/urlPreview.ts`) fetches HTML (8s/3MB caps, redirect-validated), scrapes OG tags via `open-graph-scraper`, **re-hosts og:image to R2**, updates the element. `/api/units/url-preview/enrich` self-heals stuck `pending` units. Client-safe helpers in `lib/urlPreviewShared.ts`. Action: `createUrlPreview`.

## Export
- **Markdown** (`lib/exportBoard.ts`): render a board's soft units (DocTabs/text/lists+cards/url-previews) to `.md` with sanitized filenames. **ZIP** (`lib/exportZip.ts` via `fflate`): whole subtree as a folder tree — batched level-order BFS (no N+1), R2 blobs resolved through a 6-worker pool with size guards (50 MB/object, 150 MB total, 5000 entries). Served by `POST /api/boards/download`.
- `/api/boards/meta` lists boards; `/api/boards/suggest-meta` AI-suggests a board description (Haiku, gated + metered).

## Stock Viewer (satellite)
- Full viewer is a **satellite app** at `stocks.syncedsys.com` (repo `daniel20000xd-ctrl/stocks.syncedsys`). Hub role is minimal: **`/api/stocks`** thin proxy (auth-checks caller, forwards with cookies to `STOCKS_API_URL`, 503 if unreachable). `stocks_enabled` flag lives in **`user_metadata`** (no migration) via `get/setStocksEnabled`; Sidebar/settings gate the button (`StockViewerSettings.tsx`).
- **Portal embed**: `components/free/StockPortal.tsx` (`viewerKind === 'stocks'`); `buildViewerContext()` formats the full API response to plain text → `data.viewer_context` → Claude reads it verbatim (zero-loss).

## iOS sync
- **`/api/sync`**: `Authorization: Bearer <token>` → paired `device_links` row → returns **ALL** that user's boards + lists/cards/elements. `force-dynamic` + `no-store` (Vercel was edge-caching it). **All boards sync by default**; `boards.synced=false` is an **opt-OUT** via the "Sync to iOS" toggle (`setBoardSynced`).
- **`/api/devices/pair`** — body `{ code, name? }` marks the unpaired `device_links` row paired → `{ token, deviceId, userId }`. Sidebar/settings manage codes (`DevicePairingSettings.tsx`, `createDeviceLink`/`removeDeviceLink`). The iOS app is not in this repo.

## Storage, limits, cron, admin
- **Limits (`lib/limits.ts`)**: free users = 2 GB R2 + `CLAUDE_FREE_ALLOWANCE_USD`; **admins = unlimited** (`isAdminEmail`). `getStorageUsage()` scans R2 by app; `StorageMeter.tsx` shows the bar. Satellite storage base URL in `lib/storageUrl.ts` (`NEXT_PUBLIC_STORAGE_URL`).
- **Cron (`vercel.json`)**: `/api/cron/cleanup` daily 02:00 (delete expired boards/lists/cards/elements; reset due recurring cards via `lib/recur.ts`); `/api/cron/cleanup-photos` daily 03:00. Both gated by **`CRON_SECRET`** bearer.
- **Admin**: `ADMIN_EMAIL` env (case-insensitive, `lib/admin.ts`). `/admin` console, `/admin/photos`, legacy `/overview`. `getAdminClaudeBilling()` (service-role) aggregates per-user spend for invoicing.

## Environment / deploy
Vercel env vars (`.env.local` mirrors; **`.env.local.example` is incomplete** — this list supersedes it):
- **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, **`SUPABASE_JWT_SECRET`** (mint MCP user JWTs).
- **Core**: `ADMIN_EMAIL` (=`Daniel20000xd@gmail.com`), **`APP_ENCRYPTION_KEY`** (AES-256-GCM, required for Claude/Google key encryption + OAuth codes).
- **Claude billing**: `ANTHROPIC_API_KEY` (platform key), `CLAUDE_MARKUP` (default 1.0), `CLAUDE_FREE_ALLOWANCE_USD` (default 0.5), `CLAUDE_API_ENABLED` (kill switch).
- **R2**: `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (default `syncedsys-storage`).
- **Google**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- **Other**: `COMPANION_APP_SECRET` (iOS photo upload), `CRON_SECRET` (Vercel cron auth), `LIBRARY_INGEST_KEY` (fetch-cases ingest), `STOCKS_API_URL` (default `https://stocks.syncedsys.com`), `NEXT_PUBLIC_STORAGE_URL`.

## ⚠️ DB MIGRATION STATE — READ FIRST
The live Supabase DB was created from an early schema and is repeatedly missing newer pieces; **the user adds them by hand**. Before debugging "X doesn't save / disappears on reload", confirm the column/table/bucket exists. Migration SQL is split across **`supabase/*.sql`** — apply the relevant file(s):
- **`schema.sql`** (447 lines) — base: `boards, lists, cards, board_edges, board_elements, device_links, account_links, user_secrets, snapshots, claude_actions, claude_usage, app_config, library_items (+ Swedish tsv), mcp_tokens`. Idempotent `alter … add column if not exists` upgrades are inline; the **Stock Viewer `stocks_enabled` + `stock_cache`** block is still **commented at the bottom** (apply by hand if needed — `/api/stocks` try/catches around the cache).
- **`claude_usage.sql`** — append-only usage ledger + `app_config` kill switch (service-role writes only).
- **`google_oauth.sql`** — `user_google_tokens` (encrypted tokens, service-role writes).
- **`mcp_setup.sql`** — `mcp_tokens` + `snapshots` + `claude_actions`. **`mcp_oauth.sql`** — `mcp_oauth_codes` (currently unused; codes are stateless).
- **`personas.sql`** — `boards.is_persona` + constraint + trigger + backfill.
- **`workspace_photos.sql`** (+ **`_v2.sql`**: `description`, `photo_library_settings`).
- **No migration needed**: `stocks_enabled` (in `user_metadata`); grouping & z-order (localStorage `groupmap-`/`zmap-<id>`); active persona (localStorage).

## Known gaps / next tasks
- **Grouping resize for list/card/sub-tab children**: position follows but `data.scale` is view-only on reload (no DB column for non-element scale) — same limitation as standalone hold+scroll scaling.
- **Deleting a container shape** leaves children with a stale `parentId` (harmless; behave as ungrouped). Not auto-cleaned.
- **Library full_text search is Postgres FTS only** (Swedish `tsvector`), no semantic/vector search. `fetch-cases.ts` ingest is two-stage/manual.
- Portal cross-tab links, portal open/invert animation, multi-point link routing — still deferred.
- `app/(app)/settings/SettingsClient.tsx` + `account_links` are largely dead code.
- In-app model is `claude-sonnet-4-5`; consider bumping to current Sonnet/Opus when revisiting `lib/claude/*`.

## Key files
- **Canvas**: `components/free/FreeBoardView.tsx` (tools, history, edges, portals, alignment guides, grouping), `components/free/nodes.tsx` (all node components + `DeletableEdge` + portal mini-renderers + viewer chooser), the Google/Stock/Text portals in `components/free/*Portal.tsx`.
- **Data layer**: `app/actions.ts` (~80 server actions — the primary API), `lib/types.ts`, `supabase/*.sql`.
- **Claude**: `app/api/claude/route.ts`, `lib/claude/{context,tools,key,gate,usage,pricing}.ts`, `components/claude/*`, `lib/claudeDropRegistry.ts`, `lib/crypto.ts`.
- **MCP**: `app/api/mcp/route.ts`, `lib/mcp.ts`/`mcpAuth.ts`/`mcpOauth.ts`/`cors.ts`, `app/api/mcp/oauth/*`, `docs/MCP_REFERENCE.md`.
- **Google**: `lib/google/*`, `app/api/google/*`, `components/DocTabsPanel.tsx`, `lib/doctabs.ts`/`docTabsStore.ts`.
- **Storage/photos/library**: `lib/r2.ts`/`limits.ts`/`pdf.ts`/`files.ts`/`exportBoard.ts`/`exportZip.ts`/`urlPreview.ts`, `app/api/photos/*`, `app/api/library/*`, `fetch-cases.ts`.
- **Shell**: `app/(app)/layout.tsx`, `app/(app)/board/[id]/page.tsx`, `components/{Sidebar,TabBar,SubTabBar,BoardDesktop,BoardsHome,NewBoardModal,BoardPropertiesPanel,PersonaSettings}.tsx`.
