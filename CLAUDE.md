# Syncedsys — Session Handoff

A Next.js 16 Trello-style + freeform-canvas board app with an on-canvas Claude assistant, PDF support, and a Stock Viewer. Supabase auth/DB, deployed on Vercel at **syncedsys.com**. Repo: `daniel20000xd-ctrl/Syncedsys` (branch `main`, push auto-deploys to Vercel).

## Stack & conventions
- **Next.js 16.2.6** App Router + Turbopack. Middleware is `proxy.ts` exporting `proxy` (Next 16 rename), not `middleware.ts`.
- **Supabase SSR** (`@supabase/ssr`): `lib/supabase/client.ts` (browser), `server.ts` (server), `admin.ts` (service role).
- **@dnd-kit** for Trello-mode drag/drop. **@xyflow/react** (v12) for the freeform "Classic" canvas.
- **Tailwind v4** (`@import "tailwindcss"`). **lucide-react** icons.
- All DB writes are Server Actions in `app/actions.ts` (`'use server'`).
- **Never** call `createClient()` at module/component top level — only in handlers/effects/async fns, or SSR prerender breaks.
- **`dynamic(() => ..., { ssr: false })` must live in a Client Component**, never a Server Component (build error otherwise). Pattern: a thin `'use client'` wrapper that default-imports the heavy component.
- Floating panels use `createPortal` so the `overflow-x-auto` tab bars don't clip them.
- Git/tooling: route-group paths contain `(app)` parens — **use the Bash tool** (PowerShell chokes on parens) or quote paths. Commit messages with parens/`@`/newlines: use a PowerShell here-string or keep them simple. `git push` over HTTPS prints to stderr which PowerShell surfaces as a red "error" even on success — check the last line (`main -> main`) to confirm.
- **`npx next build` is the real check** (tsc alone misses some ESLint); build has been kept green every commit. `npx tsc --noEmit` for fast iteration.

## Board modes (`boards.mode`, default `'classic'`)
- **`'classic'`** = freeform canvas (xyflow). **The default / standard.** → `components/free/FreeBoardView.tsx`.
- **`'trello'`** = kanban columns. → `components/BoardView.tsx`.
- **`'text'`** = plain document, autosaves to `boards.content`. → `components/TextBoardView.tsx`.
- **`'folder'`** = file explorer (sub-folders + dropped text files). → `components/FolderBoardView.tsx`.
- **`'spreadsheet'`** = grid with formulas. → `components/SpreadsheetBoardView.tsx` (`lib/spreadsheet.ts`).
- `text`/`spreadsheet` tabs are mode-locked after creation. Legacy `'free'` still routes to freeform in `app/(app)/board/[id]/page.tsx`.

## Tabs & sub-tabs
- `components/TabBar.tsx` — browser-style tabs (root boards only). Tab drag-reorder is **optimistic** (local `setBoards` first, then `moveTab` server action, then `router.refresh()`).
- `components/SubTabBar.tsx` — stacked rows under the main tabs (ancestor chain).
- `components/BoardPropertiesPanel.tsx` — shared panel (name, color, expiry, preset, **"Sync to iOS" toggle**, Add sub-tab, optional **Remove tab**). Calls `router.refresh()` on save.
- Boards self-reference via `parent_id` + `tab_position` (infinite nesting; sub-tabs are just child boards). Groups via `group_id` + `is_group`.

## Free-mode canvas — `components/free/FreeBoardView.tsx` + `nodes.tsx`
Toolbar (top-right, icon-only, vertical): **Select / Hand / Draw / Shape / Text / Portal / Claude** (shortcuts V/H/P/R/—/F/C).
- **Select**: left-drag = marquee multi-select; Delete removes selection. Middle/right-drag pans. Recolor swatches appear when shapes/drawings/text are selected.
- **Draw / Shape / Text / Portal / Claude**: pointer overlay (`overlayActive`) intercepts input. Shape / Portal / Claude = press-drag-release (drag a box, live dashed preview), sized in flow units via `beginBoxDraw`/`commitBoxDraw`. Shapes: rect/circle/arrow. Text = click to drop.
- **Right-click empty canvas** → context menu (list/card/sub-tab/image/draw/shape). **Add sub-tab** opens a **mode picker modal** (`SubtabModePicker`) before creating.
- **Hold a unit + scroll = resize it** (NOT zoom) — capture-phase wheel listener on the wrapper; shapes/portals resize w/h, others scale `data.scale`. Persists on mouseup.
- **Undo `Ctrl+Z` / Redo `Ctrl+X`**: debounced snapshot history; reconciles DB via `upsertElement` (client-generated UUIDs). `elTypeOf` maps node types incl. `pdfNode→'pdf'`, `claudeNode→'claude'`.
- **Links (edges)**: 4 side handles per node, `ConnectionMode.Loose`. **Handles are invisible until the cursor is near** (JS proximity writes inline `opacity`; CSS `.rf-connecting` makes all handles pulse during an active connection drag). Hover a link → bend dot + colour + × delete; drag to bend (quadratic, persisted in `board_edges.data {cx,cy}`).
- **`scheduleRefresh()`** debounces `router.refresh()` at **250 ms** (was 1500 — caused position-revert-on-tab-switch).

### Alignment guides (snap lines) — NEW
- Wrapped `onNodesChange` runs the React Flow "helper-lines" pattern. Dragging a single node snaps (within **5 flow-px**) to other nodes' left/right/center/top/bottom/edge alignments; **pink guide lines span the board** while dragging, cleared on drop.
- Pure module-level `computeGuides()` + `getNodeWH()` (with `DEFAULT_W/H` fallbacks). `helperRef` guards re-render churn. Multi-select drags (`changes.length > 1`) are not snapped.

### Grouping — drop units/shapes into shapes — NEW
- **Containers are `shapeNode`s.** Drag any node onto a shape → it becomes a child (`data.parentId = shapeId`); a **green dashed ring** highlights the target during drag.
- **Move**: dragging a container translates all descendants by the same delta (`onNodeDrag`, tracked via `groupDragRef`).
- **Resize** (BOTH gestures): hold+scroll (in the wheel handler) and corner-handle `NodeResizer` (detected via `dimensions` changes with `resizing:true` in `onNodesChange`, mapped from a start `resizeSnapshotRef` to avoid drift) scale + reposition descendants. Box children scale w/h; others scale `data.scale`.
- **Detach**: drag a child out of all shapes. **Nesting** is supported (`descendantsOf` is transitive) and cycle-safe.
- **Persistence**: child→parent map saved to **`localStorage` `groupmap-<boardId>`** (same zero-schema pattern as z-order `zmap-<boardId>`); element children also keep `parentId` in their jsonb data. Hydrated on mount; undo/redo re-syncs the map. **No DB schema change.**
- All of this lives in `FreeBoardView.tsx` in **absolute coordinates** — deliberately NOT React Flow's native `parentId`/`extent` model (avoids node-ordering constraints). `nodes.tsx` was not touched for grouping.

## Units dashboard (sidebar)
- `lib/unitsStore.ts` — module store bridging canvas ↔ `Sidebar.tsx` via `useSyncExternalStore`. Has `select/reorder/setOpacity/setHidden/rename` handlers; `Unit.mode` carries sub-tab board mode.
- `components/UnitsPanel.tsx` — every unit (top = front layer): click→select, drag→layer order (`data.z` + zmap), gear→opacity, eye→hide/show, **double-click→inline rename** (routes to the right DB record per node type). Mode-aware icons for sub-tabs (`AlignLeft`/`TableProperties`/`LayoutDashboard`/`Square`).

## Portals — `PortalNode` in `nodes.tsx`
A resizable window showing a live view of another tab **or a built-in Viewer**.
- The **⌄ chooser is split into two sections**: **Viewers** (currently "Stock Viewer") and **Tabs** (the board list + "New sub-tab"). Picking a viewer sets `data.viewerKind`/`viewerConfig` and clears `targetBoardId`; picking a tab clears the viewer. They're mutually exclusive.
- **Board portals**: render the target's lists/cards/shapes/text/drawings/images + links; pan by dragging, **plain scroll = pan, Ctrl/⌘+scroll = zoom** (inside the portal only). Auto-fit once; **Lock** freezes pan/zoom; text/folder/spreadsheet targets render their own editors/previews. Auto-mirror via `ensureMirrorPortal`.
- Element type `'portal'`; data = `{ targetBoardId, home, vx, vy, zoom, locked, fitted, width, height, viewerKind?, viewerConfig?, viewer_context? }`. `persist()` carries viewer fields + `viewer_context` forward on every pan/zoom/resize.

## Claude on the canvas — `components/claude/`
- **`ClaudeNode`** (in `nodes.tsx`) = a resizable chat box on the canvas with an outward **"claude orange" neon glow** (`.claude-node-glow` in `globals.css`). Dark theme (`#30302E`/`#262624`). Scoped to its board (`data.boardId`) and everything reachable downward.
- **`ClaudeChat.tsx`** — chat UI. Files/PDFs dropped onto it become **attachment chips** (thumbnail for PDFs via `renderPdfThumbnail`), injected through the module-level **`lib/claudeDropRegistry.ts`** (`ChatAttachment` type) rather than raw text.
- **`app/api/claude/route.ts`** — streams from Anthropic using the user's own key.
- **API key**: stored **encrypted** (AES-256-GCM, `lib/crypto.ts`) in `user_secrets.anthropic_key_encrypted`. Requires env **`APP_ENCRYPTION_KEY`**. Settings UI: `components/ClaudeKeySettings.tsx` (+ `getClaudeStatus`/`saveAnthropicKey`/`removeAnthropicKey`/`setClaudeAutoApply`).
- **`lib/claude/context.ts`** — builds Claude's scope (BFS down from root board through children + portal/folder-link targets) and a text snapshot of everything in scope. **Renders PDFs' extracted text** and **viewer-portal data** (see Stock Viewer below).
- `lib/claude/tools.ts` — tool definitions (read/write board ops, gated by `claude_auto_apply`).

## PDFs
- Drop a PDF on the canvas/folder → a **`pdfNode`** (red file block, opens the stored PDF in a new tab). Drop near a Claude node → injected as a chat attachment; near a sub-tab → lands in that board.
- `lib/pdf.ts`: `extractPdfText` (pdfjs, CDN worker, 120k cap), `uploadPdf` (Supabase Storage bucket **`pdfs`**), `renderPdfThumbnail` (page-1 JPEG data-URL).
- `getPdfUrl(path)` server action mints a 1-hour signed URL. Element type `'pdf'`, data `{ name, storagePath, text, pageCount }`.
- Drop routing (text + PDFs) uses **magnetic targeting** (`MAGNETIC_RADIUS`): a pulsing ring shows whether the drop will go to a Claude chat, a sub-tab board, or the canvas.

## Stock Viewer
The full stock viewer is a **satellite app** at `stocks.syncedsys.com` (repo: `daniel20000xd-ctrl/stocks.syncedsys`). The hub's role is minimal:
- **`/api/stocks`** (`app/api/stocks/route.ts`) — a thin proxy: auth-checks the caller, then forwards the request (with cookies) to `STOCKS_API_URL` (default `https://stocks.syncedsys.com`). Returns 503 if the satellite is unreachable.
- **`stocks_enabled` flag** in `user_metadata` still gates the Sidebar button; `getStocksEnabled`/`setStocksEnabled` still live in `app/actions.ts`. Settings toggle: `components/StockViewerSettings.tsx`.
- **Portal embed**: `components/free/StockPortal.tsx` — compact chart inside a `PortalNode` (`viewerKind === 'stocks'`). `buildViewerContext()` formats the full API response as plain text and writes it to `data.viewer_context`; `lib/claude/context.ts` injects it verbatim so Claude reads stocks with no information loss.

## iOS sync
- **`/api/sync`** (`app/api/sync/route.ts`): header `Authorization: Bearer <token>` → looks up the paired `device_links` row → returns **ALL of that user's boards** + their lists/cards/elements. `export const dynamic = 'force-dynamic'` + `Cache-Control: no-store` headers (Vercel was edge-caching it).
  - **History note**: the original `.eq('synced', true)` filter was a bug — every board defaults to `synced=false` and there was no UI to flip it, so the app always got empty arrays. The filter was removed; **all boards sync by default**, and the `BoardPropertiesPanel` "Sync to iOS" toggle is now an **opt-OUT** (`synced=false` = excluded), via `setBoardSynced`.
- **`/api/devices/pair`** — body `{ code, name? }` → marks the unpaired `device_links` row paired, returns `{ token, deviceId, userId }`.
- **Sidebar** "Connected apps" list with `+` (`createDeviceLink` → 6-char code) / `×` (`removeDeviceLink`).
- The iOS app itself is not in this repo.

## Admin overview
- `ADMIN_EMAIL` env designates admin. `app/(app)/overview/page.tsx` uses the service-role client to list all users' boards. `account_links` table exists but is effectively unused.

## Environment / deploy
Vercel env vars (then redeploy):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`
- **`APP_ENCRYPTION_KEY`** — required for Claude API-key encryption (AES-256-GCM). If missing, saving a Claude key fails with a clear error.
- `.env.local` mirrors these. `ADMIN_EMAIL=Daniel20000xd@gmail.com`.

## ⚠️ DB MIGRATION STATE — READ FIRST
The live Supabase DB was created from an early schema and is missing things repeatedly; the user adds them by hand. **Before debugging "X doesn't save / disappears on reload", confirm the column/table/bucket exists.** Idempotent set lives commented at the bottom of `supabase/schema.sql`. Pieces relevant now:

```sql
-- Stock Viewer cache (OPTIONAL — /api/stocks try/catches around it; without it, every call fetches fresh)
create table if not exists stock_cache (
  ticker text not null, interval text not null,
  data jsonb not null, fetched_at timestamptz not null default now(),
  primary key (ticker, interval)
);
alter table stock_cache enable row level security;
create policy "auth read stock cache"  on stock_cache for select using (auth.uid() is not null);
create policy "auth write stock cache" on stock_cache for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- PDFs: private Storage bucket "pdfs" + per-user-folder RLS (see schema.sql for the policy block)
-- user_secrets: anthropic_key_encrypted text, claude_auto_apply boolean  (Claude)
-- boards.synced boolean, device_links table  (iOS sync — from earlier sessions)
-- board_edges.data jsonb  (link bending)
```

- **`stocks_enabled` needs NO migration** — it lives in `auth.users.user_metadata`, set via `setStocksEnabled`.
- **Grouping & layer order need NO migration** — both are localStorage (`groupmap-<id>`, `zmap-<id>`).

## Known gaps / next tasks
- **Grouping resize for list/card/sub-tab children**: their position follows but their `data.scale` is view-only on reload (no DB column for non-element scale) — same long-standing limitation as standalone hold+scroll scaling.
- **Deleting a container shape** leaves children with a stale `parentId` (harmless; they just behave as ungrouped). Not auto-cleaned.
- Portal cross-tab links, portal open/invert animation, multi-point link routing — all still deferred.
- `app/(app)/settings/SettingsClient.tsx` + `account_links` are dead code — safe to delete.

## Key files
- `components/free/FreeBoardView.tsx` — the canvas: tools, history, units publish, edges, portals wiring, **alignment guides + grouping** (`computeGuides`, `descendantsOf`, `getNodeWH` are module-level helpers near the top). Large; most free-mode logic lives here.
- `components/free/nodes.tsx` — all node components (List/Card/Shape/Image/Drawing/SubTab/Text/TextFile/**Pdf**/FolderLink/Portal/**Claude**) + `DeletableEdge` + `SideHandles` + portal mini-renderers + the **split Viewers/Tabs chooser**.
- `components/free/StockPortal.tsx` — embedded stock chart in a portal node + `buildViewerContext` (Claude feed).
- `components/StockViewerSettings.tsx`, `app/(app)/settings/connected-apps/page.tsx` — enable toggle.
- `app/api/stocks/route.ts` — proxy to satellite.
- `app/api/sync/route.ts`, `app/api/devices/pair/route.ts`, `app/api/claude/route.ts`.
- `lib/claude/{context,tools}.ts`, `components/claude/{ClaudeChat,ClaudeAgent,ClaudeMark}.tsx`, `lib/claudeDropRegistry.ts`, `lib/crypto.ts`.
- `lib/pdf.ts`, `lib/files.ts` (drop parsing → `{trees, files, pdfs, skipped}`).
- `app/actions.ts` — all server actions. `lib/types.ts`, `lib/unitsStore.ts`, `components/{UnitsPanel,Sidebar,TabBar,SubTabBar,BoardPropertiesPanel}.tsx`.
