# Syncedsys — Session Handoff

A Next.js 16 Trello-style + freeform kanban app. Supabase auth/DB, deployed on Vercel at **syncedsys.com**.

## Stack & key conventions
- **Next.js 16.2.6** (App Router, Turbopack). NOTE: middleware is renamed — the file is `proxy.ts` exporting a `proxy` function, not `middleware.ts`.
- **Supabase SSR** (`@supabase/ssr`): browser client (`lib/supabase/client.ts`), server client (`lib/supabase/server.ts`), admin/service-role client (`lib/supabase/admin.ts`).
- **@dnd-kit** for Trello-mode drag-drop. **@xyflow/react** for Classic (freeform) canvas.
- **Tailwind v4** (`@import "tailwindcss"`).
- All DB mutations are Server Actions in `app/actions.ts` (`'use server'`).
- **Critical SSR rule:** never call `createClient()` at module/component top level — only inside handlers/effects/async fns, or the build prerender breaks.
- React **portals** (`createPortal`) used for floating panels so `overflow-x-auto` tab bars don't clip them.

## Board modes (IMPORTANT — recently renamed)
`boards.mode` column, default `'classic'`:
- **`'classic'`** = freeform canvas (xyflow). **This is the new default / standard.** Rendered by `components/free/FreeBoardView.tsx`.
- **`'trello'`** = kanban columns (the old "classic"). Rendered by `components/BoardView.tsx`.
- **`'text'`** = plain document editor, auto-saves to `boards.content`. Rendered by `components/TextBoardView.tsx`.
- Legacy `'free'` value is still accepted by `app/(app)/board/[id]/page.tsx` and routed to freeform, in case any unmigrated rows remain.

## Sub-tabs
- Boards self-reference via `parent_id` + `tab_position`. A sub-tab is just a child board reusing all board infra, so it can itself be classic/trello/text and have its own sub-tabs (infinite nesting).
- `components/TabBar.tsx` — main browser-style tab row, root boards only (`parent_id IS NULL`). Alt+Q / Alt+W cycle tabs.
- `components/SubTabBar.tsx` — stacked rows below main tabs, one per ancestor depth level. `+` creates a sub-tab **instantly** (named "Tab N", no name prompt). Each sub-tab has a ⌄ button opening the shared properties panel.
- `components/BoardPropertiesPanel.tsx` — shared panel (used by both TabBar and SubTabBar): name, color swatches, optional expiry, preset selector (Classic/Trello/Text), "Add sub-tab". Calls `router.refresh()` on save so the server-rendered board view actually re-renders.

## Free-mode (Classic) canvas features — `components/free/`
- `FreeBoardView.tsx`: xyflow canvas. Right-click background → context menu (create list / card / sub-tab / image / draw / shape). Top-right tool panel is now **icon-only** (Select/Draw/Shape via lucide icons).
- Sub-tabs render as draggable **`SubTabNode`** boxes with an "Open →" button; their canvas position persists to `boards.free_x/free_y` via `updateBoardFreePosition`.
- **Hold a node + scroll wheel = scale it** (0.2×–5×). Element scale persists to `board_elements.data.scale`; lists/cards scale is visual-only (resets on reload).
- Zoom range `minZoom 0.05` / `maxZoom 4`; drag background to pan.
- `nodes.tsx`: all node types (List/Card/Shape/Image/Drawing/SubTab) accept `data.scale` (wrapper `transform: scale()`) and `data.onHold` (sets held node on mousedown).

## Admin overview
- `ADMIN_EMAIL` env var designates the admin account. `app/(app)/overview/page.tsx` uses the service-role client to list ALL users' boards. Strictly one-way: regular accounts only see their own boards via RLS. `account_links` table exists but is unused after this simplification.

## Environment / deploy
- Vercel env vars required (Settings → Environment Variables, then redeploy): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ADMIN_EMAIL`, `SUPABASE_SERVICE_ROLE_KEY`. Vercel hides sensitive values after save (showing blank on edit is normal).
- `.env.local` mirrors these locally. `ADMIN_EMAIL=Daniel20000xd@gmail.com`.

## ⚠️ DB migration state — READ THIS
The live Supabase database was created from an **early** schema and has been missing columns that `supabase/schema.sql` assumed. The user has been adding them manually via the SQL Editor. The full idempotent migration block is commented at the bottom of `supabase/schema.sql`:

```sql
alter table boards add column if not exists mode text not null default 'classic';
alter table boards add column if not exists deadline timestamptz;
alter table boards add column if not exists parent_id uuid references boards(id) on delete cascade;
alter table boards add column if not exists tab_position integer not null default 0;
create index if not exists boards_parent_id_idx on boards(parent_id);
alter table boards add column if not exists content text;
alter table boards add column if not exists free_x double precision not null default 100;
alter table boards add column if not exists free_y double precision not null default 100;
```

As of this session's last message, the user was about to run the `mode`/`deadline`/`free_x`/`free_y` additions (the `mode` column was confirmed missing — error `42703: column "mode" does not exist`). **Before debugging any "preset won't change" or "board renders wrong mode" issue, first confirm these columns actually exist in their DB.** Do NOT run the old `UPDATE boards SET mode = 'trello' WHERE mode = 'classic'` rename lines — there was never any old `mode` data to convert; the default `'classic'` is correct.

## Known gaps / possible next tasks
- `app/(app)/settings/SettingsClient.tsx` is old account-linking UI, now unused — can be deleted.
- `account_links` table + its RLS policies in schema.sql are dead code post-simplification.
- List/card scale in free mode is not persisted (only element nodes persist scale). Could add columns if wanted.
- No confirmation dialog on sub-tab/board delete from canvas (`deleteBoard` cascades children).
- Text mode has no formatting — plain textarea by design (user said fancy text settings not needed yet).

## Repo
GitHub: `daniel20000xd-ctrl/Syncedsys` (branch `main`). Push triggers Vercel auto-deploy. Commits are co-authored with the Claude model. Git in this repo: route-group paths contain parentheses — quote paths or use the Bash tool (PowerShell chokes on `(app)`).
