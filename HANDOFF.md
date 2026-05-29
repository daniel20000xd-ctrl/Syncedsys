# Syncedsys — Session Handoff

A Next.js 16 Trello-style + freeform-canvas board app. Supabase auth/DB, deployed on Vercel at **syncedsys.com**. Repo: `daniel20000xd-ctrl/Syncedsys` (branch `main`, push auto-deploys to Vercel).

## Stack & conventions
- **Next.js 16.2.6** App Router + Turbopack. Middleware is `proxy.ts` exporting `proxy` (Next 16 rename), not `middleware.ts`.
- **Supabase SSR** (`@supabase/ssr`): `lib/supabase/client.ts` (browser), `server.ts` (server), `admin.ts` (service role).
- **@dnd-kit** for Trello-mode drag/drop. **@xyflow/react** for the freeform "Classic" canvas.
- **Tailwind v4** (`@import "tailwindcss"`).
- All DB writes are Server Actions in `app/actions.ts` (`'use server'`).
- **Never** call `createClient()` at module/component top level — only in handlers/effects/async fns, or SSR prerender breaks.
- Floating panels use `createPortal` so the `overflow-x-auto` tab bars don't clip them.
- Git: route-group paths contain `(app)` parens — quote paths or use the Bash tool (PowerShell chokes on parens). `npx next build` is the real check (tsc alone misses ESLint); build has been kept green every commit.

## Board modes (`boards.mode`, default `'classic'`)
- **`'classic'`** = freeform canvas (xyflow). **The default / standard.** → `components/free/FreeBoardView.tsx`.
- **`'trello'`** = kanban columns (the old "classic"). → `components/BoardView.tsx`.
- **`'text'`** = plain document, autosaves to `boards.content`. → `components/TextBoardView.tsx`.
- Legacy `'free'` value still routes to freeform in `app/(app)/board/[id]/page.tsx`.

## Tabs & sub-tabs
- `components/TabBar.tsx` — browser-style tabs (root boards only). Alt+Q/W cycle.
- `components/SubTabBar.tsx` — stacked rows under the main tabs (ancestor chain). `+` creates a sub-tab **instantly** ("Tab N", no prompt). Each has a ⌄ → shared properties panel.
- `components/BoardPropertiesPanel.tsx` — shared panel (name, color, expiry, preset, Add sub-tab, optional **Remove tab**). Props: `showAddSubTab`, `onRemove`. Calls `router.refresh()` on save so the server-rendered board view actually re-renders.
- Boards self-reference via `parent_id` + `tab_position` (infinite nesting; sub-tabs are just child boards).

## Free-mode canvas — `components/free/FreeBoardView.tsx` + `nodes.tsx`
Toolbar (top-right, icon-only, vertical): **Select / Hand / Draw / Shape / Text / Portal**.
- **Select**: left-drag = marquee multi-select; Delete removes selection (persisted, incl. orphaned card nodes). Middle/right-drag pans. Recolor swatches appear when shapes/drawings/text are selected.
- **Hand** (shortcut `H`, ignored while typing): left-drag pans.
- **Draw**: pointer-capture freehand, hold-to-draw, release ends a stroke; stays armed. Points captured in **flow coords** (fixed a size/offset jump bug).
- **Shape**: click-move-click with live dashed preview (rect/circle/diamond), resizable via NodeResizer; click center to edit label; label font auto-scales to shape size (ResizeObserver).
- **Text**: click to drop an editable text box (auto-focuses).
- **Portal**: see below.
- **Right-click empty canvas** → context menu (create list/card/sub-tab/image/draw/shape). Auto-dismisses on window blur / tab switch / pointer leaving viewport / Escape. Won't reopen if already open. **Create card** auto-creates a list if none exists.
- **Navigation**: scroll = zoom (cursor-anchored, works with any tool via overlay `onWheel`), `elevateNodesOnSelect={false}` so layering is authoritative, minZoom 0.05.
- **Hold a unit + scroll = resize it** (NOT zoom). Implemented via a **capture-phase** wheel listener on the wrapper that stops propagation when `heldNodeRef` is set, so React Flow's pane zoom never fires. Shapes/portals resize w/h; others scale `data.scale`. Persists on mouseup.
- **Undo `Ctrl+Z` / Redo `Ctrl+X`** (ignored while typing): debounced snapshot history of nodes+edges; reconciles DB via `upsertElement` (restores deleted elements by original id) + position updates. Elements use **client-generated UUIDs** + upsert (no temp-id dance).
- **Links (edges)**: drag from any side handle (4 per node, `ConnectionMode.Loose`). Hover a link → blue drag-dot + × delete. **Grab and pull a link to bend it** (quadratic curve through the grab point); persists in `board_edges.data` (`{cx,cy}` offset from midpoint) via `updateEdgeShape`; ⟲ straightens. Custom edge = `DeletableEdge` in `nodes.tsx`. Auto list→card links are dashed/grey and not editable.

## Units dashboard (sidebar)
- `lib/unitsStore.ts` — module store bridging the canvas (in the page) and `components/Sidebar.tsx` (in the layout) via `useSyncExternalStore`. FreeBoardView publishes units + registers handlers; clears on unmount.
- `components/UnitsPanel.tsx` — lists every unit on the current free board (top = front layer):
  - click → select on board
  - drag up/down → layer order (zIndex; persists to element `data.z`)
  - gear → **opacity** slider (persists to element `data.opacity`)
  - Lists/cards/sub-tabs apply opacity/order in-session only (no DB column).

## Portals — `PortalNode` in `nodes.tsx`
A resizable window showing a live read-only view of another tab.
- Draw with the Portal tool → empty rectangle → **"Choose a tab…"** dropdown (all boards, home hidden).
- Renders the target board's lists/cards/shapes (with **labels**)/text/drawings/images, plus **links** (`PortalEdges`, manual blue + auto dashed, non-scaling stroke).
- **Drag inside** to pan that view independently; **scroll inside** zooms the portal view (uses `nowheel` + internal handler), not the main board.
- **Auto-fit** to content bounds once on first load (persisted `fitted` flag; never overrides a saved/locked view).
- **Lock** toggle (top bar): freezes the current pan/zoom (saved as `vx,vy,zoom`) so it always shows that region; disables pan/zoom/re-fit/change-tab while locked.
- **Text-target portals** render an editable textarea writing back to that board's `content` (debounced).
- **Maximize** corner button = open that tab fully (navigates).
- **Auto-mirror**: choosing a target inserts a portal back on the target board via `ensureMirrorPortal(targetBoardId, home)`. Portal data carries `home` (its own board id).
- Portal element type is `'portal'` in `board_elements`; data = `{ targetBoardId, home, vx, vy, zoom, locked, fitted, width, height }`.

## iOS sync (groundwork — the iOS app does not exist yet)
Goal: mark certain tabs as "synced" and let a future iOS app pull them.
- `boards.synced` boolean flagged per-tab via the **"Sync to connected iOS apps"** checkbox in `BoardPropertiesPanel`. Server action `setBoardSynced(boardId, synced)`.
- `device_links` table = paired apps/devices. Actions: `createDeviceLink(name)` → returns a **6-char pairing code** + stores a secret `token`; `removeDeviceLink(id)`.
- **REST API the app will call** (both use `createAdminClient()` / service role, since the device has no Supabase session):
  - `POST /api/devices/pair` — body `{ code, name? }` → finds the unpaired `device_links` row by code, marks it paired, returns `{ token, deviceId, userId }`.
  - `GET /api/sync` — header `Authorization: Bearer <token>` → looks up the paired device by token, bumps `last_seen`, returns `{ boards, lists, cards, elements }` for that user's `synced` boards.
- **Sidebar UI** (`components/Sidebar.tsx`, receives `devices` from layout):
  - Dashboard has a divider: units (or lists) above, a **"Synced tabs"** list (all `boards.synced`) below.
  - Above Settings: a **"Connected apps"** list with `+` (calls `createDeviceLink`, shows the code inline) and `×` remove; pending (un-paired) devices show a "pending" badge.
- Connection flow for the future app: user taps **+** → gets code → enters it in the app → app `POST /api/devices/pair` → stores token → polls `GET /api/sync`.
- Not yet done (fine to add when the app exists): pairing-code expiry, write-back from the app (sync is read-only), push/realtime.

## Admin overview
- `ADMIN_EMAIL` env designates admin. `app/(app)/overview/page.tsx` uses the service-role client to list all users' boards. One-way only; `account_links` table exists but is unused.

## Environment / deploy
- Vercel env vars (Settings → Environment Variables, then redeploy): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ADMIN_EMAIL`, `SUPABASE_SERVICE_ROLE_KEY`. Vercel hides sensitive values after save (blank-on-edit is normal).
- `.env.local` mirrors these. `ADMIN_EMAIL=Daniel20000xd@gmail.com`.

## ⚠️ DB MIGRATION STATE — READ FIRST
The live Supabase DB was created from an early schema and has been missing columns/tables repeatedly; the user adds them by hand. **Before debugging "X doesn't save / disappears on reload", confirm the column/table exists.** The full idempotent migration set lives commented at the bottom of `supabase/schema.sql`. Current required pieces:

```sql
-- boards
alter table boards add column if not exists mode text not null default 'classic';
alter table boards add column if not exists deadline timestamptz;
alter table boards add column if not exists parent_id uuid references boards(id) on delete cascade;
alter table boards add column if not exists tab_position integer not null default 0;
alter table boards add column if not exists content text;
alter table boards add column if not exists free_x double precision not null default 100;
alter table boards add column if not exists free_y double precision not null default 100;
create index if not exists boards_parent_id_idx on boards(parent_id);

alter table boards add column if not exists synced boolean not null default false;

-- board_elements (shapes/drawings/text/images/portals) + RLS  (full create-if-not-exists + policy in schema.sql)
-- board_edges
alter table board_edges add column if not exists data jsonb not null default '{}';  -- link bend {cx,cy}

-- device_links (iOS sync) — run the full create table + RLS policy block from schema.sql:
create table if not exists device_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null default 'iOS device',
  pairing_code text, token text not null,
  paired boolean not null default false,
  last_seen timestamptz, created_at timestamptz default now()
);
alter table device_links enable row level security;
create policy "users manage their device links" on device_links for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists device_links_user_idx on device_links(user_id);
```

As of this session's end, the most recently added pieces are **`boards.synced`** and the **`device_links`** table — the user must run those for iOS-sync UI/API to work (and `board_edges.data` from the prior session for link-bending). Do NOT run the old `UPDATE boards SET mode=...` rename lines (there was never old mode data).

## Known gaps / next tasks
- **iOS app** itself isn't built — only the pairing/sync API + UI groundwork exists (see "iOS sync" above).
- **Portal cross-tab links** (links from a main-tab unit to a unit shown inside a portal, visible on both tabs) — deferred. Bringing this in should also add "remove portal → remove its cross-tab links".
- **Portal invert/open animation** (smooth zoom-swap where the portal becomes the full board at the same screen proportion) — deferred; "Maximize" just navigates today.
- Removing a portal does **not** remove its auto-mirror on the other tab (they're independent).
- Portal mini-view draws links **straight** (ignores saved bends); could honor `data.cx/cy`.
- Link bending is a single control point; multi-point routing would be a bigger change.
- Opacity/layer order for lists/cards/sub-tabs is session-only (no DB columns).
- `app/(app)/settings/SettingsClient.tsx` and the `account_links` table/policies are dead code (post-simplification) — safe to delete.
- List/card scale via hold+scroll is visual-only on reload for non-element nodes.

## Key files
- `components/free/FreeBoardView.tsx` — the canvas (tools, history, units publish, edges, portals wiring). Large; most free-mode logic lives here.
- `components/free/nodes.tsx` — all node components (List/Card/Shape/Image/Drawing/SubTab/Text/Portal) + `DeletableEdge` + `SideHandles` + portal mini-renderers (`MiniUnit`, `PortalEdges`).
- `app/actions.ts` — server actions (boards, lists, cards, elements upsert/delete, edges upsert/delete/shape, sub-tabs, mirror portal, board content/free position, setBoardSynced, createDeviceLink/removeDeviceLink).
- `app/api/devices/pair/route.ts`, `app/api/sync/route.ts` — REST endpoints for the future iOS app (service-role).
- `lib/types.ts` (incl. `DeviceLink`), `lib/unitsStore.ts`, `components/UnitsPanel.tsx`, `components/Sidebar.tsx`, `components/TabBar.tsx`, `components/SubTabBar.tsx`, `components/BoardPropertiesPanel.tsx`.
