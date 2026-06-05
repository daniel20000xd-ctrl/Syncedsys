-- ── "Bring your own Claude" — MCP per-user access tokens ──────────────────────
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Lets a user mint opaque tokens (stored only as a SHA-256 hash) so external
-- Claude clients can authenticate to /api/mcp as them, without an Anthropic key.

create table if not exists mcp_tokens (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        references auth.users(id) on delete cascade not null,
  token_hash    text        not null unique,         -- sha256(token); plaintext never stored
  name          text        not null default 'Claude',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  window_start  timestamptz,                          -- fixed-window rate limiter
  request_count integer     not null default 0
);
create index if not exists mcp_tokens_hash_idx on mcp_tokens(token_hash);
create index if not exists mcp_tokens_user_idx on mcp_tokens(user_id);

alter table mcp_tokens enable row level security;
drop policy if exists "users manage their mcp tokens" on mcp_tokens;
create policy "users manage their mcp tokens" on mcp_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- The MCP route resolves tokens via the service role (bypasses RLS), so this
-- policy only governs the user-facing list/create/revoke in Settings.

-- ── Audit tables: snapshots & claude_actions ──────────────────────────────────
-- The MCP write path calls snapshotBefore()/logAction() on every mutation. These
-- create-if-not-exists blocks use the canonical schema (see supabase/schema.sql)
-- with user_id + RLS already present, so this works whether the tables pre-exist
-- (e.g. from an earlier session) or not. The follow-up ALTERs backfill user_id on
-- any legacy copy that predates the column; they are no-ops on a fresh create.

create table if not exists snapshots (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        references auth.users(id) on delete cascade,
  entity_type  text        not null,                 -- 'board' | 'list' | 'card' | 'element' | 'edge'
  entity_id    uuid        not null,
  data         jsonb       not null,
  changed_at   timestamptz not null default now(),
  triggered_by text
);
create index if not exists snapshots_entity_idx on snapshots(entity_type, entity_id);

create table if not exists claude_actions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        references auth.users(id) on delete cascade,
  tool         text        not null,
  params       jsonb       not null default '{}',
  affected_ids uuid[]      not null default '{}',
  executed_at  timestamptz not null default now()
);
create index if not exists claude_actions_tool_idx on claude_actions(tool);

-- Backfill user_id on any legacy table that predates the column (no-op on fresh create).
alter table snapshots      add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table claude_actions add column if not exists user_id uuid references auth.users(id) on delete cascade;

alter table snapshots      enable row level security;
alter table claude_actions enable row level security;

drop policy if exists "users own their snapshots" on snapshots;
create policy "users own their snapshots" on snapshots for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "users own their claude actions" on claude_actions;
create policy "users own their claude actions" on claude_actions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
