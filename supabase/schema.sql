-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Boards
create table boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  color text not null default '#0079bf',
  deadline timestamptz,
  mode text not null default 'classic',
  parent_id uuid references boards(id) on delete cascade,
  tab_position integer not null default 0,
  content text,
  free_x double precision not null default 100,
  free_y double precision not null default 100,
  synced boolean not null default false,
  meta text,
  created_at timestamptz default now()
);

-- Connected iOS apps / devices that sync the user's synced boards
create table if not exists device_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null default 'iOS device',
  pairing_code text,                 -- short code the user enters in the app; cleared once paired
  token text not null,               -- secret bearer token the device uses for the sync API
  paired boolean not null default false,
  last_seen timestamptz,
  created_at timestamptz default now()
);
alter table device_links enable row level security;
create policy "users manage their device links" on device_links for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists device_links_user_idx on device_links(user_id);

-- Add x/y to lists and cards for free mode positioning
-- (run ALTER TABLE statements below if upgrading an existing db)

alter table boards enable row level security;

create policy "Users own their boards"
  on boards for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Lists
create table lists (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references boards(id) on delete cascade not null,
  name text not null,
  position integer not null default 0,
  x double precision not null default 0,
  y double precision not null default 0,
  created_at timestamptz default now()
);

alter table lists enable row level security;

create policy "Users access lists through boards"
  on lists for all
  using (
    exists (
      select 1 from boards
      where boards.id = lists.board_id
        and boards.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from boards
      where boards.id = lists.board_id
        and boards.user_id = auth.uid()
    )
  );

-- Cards
create table cards (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references lists(id) on delete cascade not null,
  title text not null,
  description text,
  position integer not null default 0,
  x double precision not null default 0,
  y double precision not null default 0,
  created_at timestamptz default now()
);

-- Board edges (manual connections in free mode)
create table board_edges (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references boards(id) on delete cascade not null,
  source text not null,
  target text not null,
  source_handle text,
  target_handle text,
  data jsonb not null default '{}',
  created_at timestamptz default now()
);

alter table board_edges enable row level security;

create policy "Users access edges through boards"
  on board_edges for all
  using (exists (select 1 from boards where boards.id = board_edges.board_id and boards.user_id = auth.uid()))
  with check (exists (select 1 from boards where boards.id = board_edges.board_id and boards.user_id = auth.uid()));

-- Board elements (shapes, images, drawings in free mode)
create table board_elements (
  id uuid primary key default gen_random_uuid(),
  board_id uuid references boards(id) on delete cascade not null,
  type text not null,
  x double precision not null default 0,
  y double precision not null default 0,
  width double precision,
  height double precision,
  data jsonb not null default '{}',
  created_at timestamptz default now()
);

alter table board_elements enable row level security;

create policy "Users access elements through boards"
  on board_elements for all
  using (exists (select 1 from boards where boards.id = board_elements.board_id and boards.user_id = auth.uid()))
  with check (exists (select 1 from boards where boards.id = board_elements.board_id and boards.user_id = auth.uid()));

create index on board_edges(board_id);
create index on board_elements(board_id);

alter table cards enable row level security;

create policy "Users access cards through lists"
  on cards for all
  using (
    exists (
      select 1 from lists
      join boards on boards.id = lists.board_id
      where lists.id = cards.list_id
        and boards.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from lists
      join boards on boards.id = lists.board_id
      where lists.id = cards.list_id
        and boards.user_id = auth.uid()
    )
  );

-- Account links (cross-account overview)
create table account_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade not null,
  member_id uuid references auth.users(id) on delete cascade not null,
  label text not null default 'Linked account',
  status text not null default 'pending',
  created_at timestamptz default now(),
  unique(owner_id, member_id)
);

alter table account_links enable row level security;

create policy "users see their own links"
  on account_links for select
  using (owner_id = auth.uid() or member_id = auth.uid());

create policy "owners create links"
  on account_links for insert
  with check (owner_id = auth.uid());

create policy "members accept links"
  on account_links for update
  using (member_id = auth.uid());

create policy "either side can remove"
  on account_links for delete
  using (owner_id = auth.uid() or member_id = auth.uid());

-- Allow admin accounts to read linked members' boards
create policy "admin view linked boards"
  on boards for select
  using (
    exists (
      select 1 from account_links
      where owner_id = auth.uid()
        and member_id = boards.user_id
        and status = 'accepted'
    )
  );

-- Per-user secrets & AI settings (Anthropic API key, encrypted at rest)
create table if not exists user_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  anthropic_key_encrypted text,          -- AES-256-GCM ciphertext; never returned to the client
  claude_auto_apply boolean not null default false,  -- when true, Claude may make changes (writes)
  claude_pay_per_use boolean not null default false, -- opt-in to pay past the free platform allowance
  updated_at timestamptz not null default now()
);

alter table user_secrets enable row level security;

-- A user may read/update the row's NON-secret fields (the app only ever selects
-- claude_auto_apply / a presence flag client-side; the encrypted key is read
-- exclusively server-side). The encrypted value is useless without the
-- server-only APP_ENCRYPTION_KEY, so RLS scoping to the owner is sufficient.
create policy "users manage their own secrets" on user_secrets for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Indexes
create index on boards(user_id);
create index on boards(parent_id);
create index on account_links(owner_id);
create index on account_links(member_id);
create index on lists(board_id);
create index on cards(list_id);

-- Migration: run these if upgrading an existing database (skip if running schema fresh).
-- All idempotent — safe to run repeatedly. 'classic' is the freeform-canvas default.
-- alter table boards add column if not exists mode text not null default 'classic';
-- alter table boards add column if not exists deadline timestamptz;
-- alter table boards add column if not exists parent_id uuid references boards(id) on delete cascade;
-- alter table boards add column if not exists tab_position integer not null default 0;
-- create index if not exists boards_parent_id_idx on boards(parent_id);
-- alter table boards add column if not exists content text;
-- alter table boards add column if not exists free_x double precision not null default 100;
-- alter table boards add column if not exists free_y double precision not null default 100;
-- alter table board_edges add column if not exists data jsonb not null default '{}';
-- alter table boards add column if not exists synced boolean not null default false;
-- alter table boards add column if not exists meta text;
-- (snapshots + claude_actions tables: run the create table + policy blocks from the MCP audit section above)
-- (claude_usage ledger: run supabase/claude_usage.sql — append-only, service-role writes)
-- (device_links table: run the create table + policy block above on existing DBs)
-- alter table cards add column if not exists done boolean not null default false;
-- alter table lists add column if not exists is_widget boolean not null default false;
-- alter table lists add column if not exists widget_position integer not null default 0;
-- alter table lists add column if not exists deadline timestamptz;
-- alter table cards add column if not exists deadline timestamptz;
-- alter table board_elements add column if not exists deadline timestamptz;
-- alter table lists add column if not exists hidden boolean not null default false;
-- alter table cards add column if not exists hidden boolean not null default false;
-- alter table cards add column if not exists done_at timestamptz;
-- alter table cards add column if not exists recur_interval_minutes integer;
-- Tab groups (symbolic groupings; deleting a group never deletes members):
-- alter table boards add column if not exists is_group boolean not null default false;
-- alter table boards add column if not exists group_id uuid references boards(id) on delete set null;
-- create index if not exists boards_group_idx on boards(group_id);
-- Per-user secrets (Anthropic key + Claude settings):
-- create table if not exists user_secrets (
--   user_id uuid primary key references auth.users(id) on delete cascade,
--   anthropic_key_encrypted text,
--   claude_auto_apply boolean not null default false,
--   updated_at timestamptz not null default now()
-- );
-- alter table user_secrets enable row level security;
-- create policy "users manage their own secrets" on user_secrets for all
--   using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── PDF storage ───────────────────────────────────────────────────────────────
-- PDFs are stored as binaries in a private Storage bucket "pdfs". Each user's
-- files live under a folder named with their auth uid, and RLS on
-- storage.objects ensures a user can only upload/read/delete their own.
-- Run this block once in the Supabase SQL editor on the live project:
--
-- insert into storage.buckets (id, name, public)
--   values ('pdfs', 'pdfs', false)
--   on conflict (id) do nothing;
--
-- create policy "pdf insert own" on storage.objects for insert to authenticated
--   with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
-- create policy "pdf select own" on storage.objects for select to authenticated
--   using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
-- create policy "pdf delete own" on storage.objects for delete to authenticated
--   using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── MCP audit log ────────────────────────────────────────────────────────────
-- Captures a before-snapshot of any entity before an MCP write tool mutates it,
-- enabling undo and diff display in future tooling.
create table if not exists snapshots (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        references auth.users(id) on delete cascade,
  entity_type  text        not null,  -- 'board' | 'list' | 'card' | 'element' | 'edge'
  entity_id    uuid        not null,
  data         jsonb       not null,
  changed_at   timestamptz not null default now(),
  triggered_by text
);
create index if not exists snapshots_entity_idx   on snapshots(entity_type, entity_id);
alter table snapshots enable row level security;
create policy "users own their snapshots" on snapshots for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Append-only log of every MCP write tool invocation.
create table if not exists claude_actions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        references auth.users(id) on delete cascade,
  tool         text        not null,
  params       jsonb       not null default '{}',
  affected_ids uuid[]      not null default '{}',
  executed_at  timestamptz not null default now()
);
create index if not exists claude_actions_tool_idx on claude_actions(tool);
alter table claude_actions enable row level security;
create policy "users own their claude actions" on claude_actions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Claude usage ledger (platform-credit billing) ─────────────────────────────
-- One row per server-side Claude request. key_source 'platform' = ran on the
-- owner's ANTHROPIC_API_KEY and is billable to the user at markup; 'user' = ran on
-- the user's own key (cost 0, billable false), kept only for their own visibility.
-- Append-only for end users: they may READ their own rows but cannot insert, edit,
-- or delete them. All writes happen server-side via the service-role client
-- (recordClaudeUsage), which bypasses RLS and stamps the trusted user_id.
create table if not exists claude_usage (
  id                    uuid          primary key default gen_random_uuid(),
  user_id               uuid          references auth.users(id) on delete cascade not null,
  created_at            timestamptz   not null default now(),
  model                 text          not null,
  key_source            text          not null check (key_source in ('user','platform')),
  billable              boolean       not null default false,
  input_tokens          integer       not null default 0,
  output_tokens         integer       not null default 0,
  cache_read_tokens     integer       not null default 0,
  cache_creation_tokens integer       not null default 0,
  cost_usd              numeric(12,6) not null default 0,  -- decimal money, never float
  turns                 integer       not null default 1,
  board_id              uuid,                              -- request meta; no FK (board may be deleted)
  errored               boolean       not null default false
);
create index if not exists claude_usage_user_idx on claude_usage(user_id, created_at desc);
create index if not exists claude_usage_billable_idx on claude_usage(user_id) where billable;
alter table claude_usage enable row level security;
-- Read-only for the owner; no insert/update/delete policy (default-deny under RLS).
create policy "claude usage select own" on claude_usage
  for select using (user_id = auth.uid());

-- ── Global app config (kill switch) ───────────────────────────────────────────
-- One row per flag. 'claude_api' = the platform Claude kill switch (when disabled,
-- platform-key requests are refused; own-key requests are unaffected). Readable by
-- any authenticated user (the request gate checks it); writes go through the
-- service-role admin action only.
create table if not exists app_config (
  key        text        primary key,
  enabled    boolean     not null default true,
  updated_at timestamptz not null default now()
);
insert into app_config (key, enabled) values ('claude_api', true)
  on conflict (key) do nothing;
alter table app_config enable row level security;
create policy "app config readable" on app_config
  for select using (auth.uid() is not null);

-- ── MCP access tokens (bring your own Claude) ─────────────────────────────────
-- Per-user opaque tokens (stored as a SHA-256 hash) that let external Claude
-- clients authenticate to /api/mcp as the user, with no Anthropic API key.
create table if not exists mcp_tokens (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        references auth.users(id) on delete cascade not null,
  token_hash    text        not null unique,
  name          text        not null default 'Claude',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  window_start  timestamptz,
  request_count integer     not null default 0
);
create index if not exists mcp_tokens_hash_idx on mcp_tokens(token_hash);
create index if not exists mcp_tokens_user_idx on mcp_tokens(user_id);
alter table mcp_tokens enable row level security;
create policy "users manage their mcp tokens" on mcp_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Stock Viewer ──────────────────────────────────────────────────────────────
-- 1. Add stocks_enabled flag to user_secrets (run once):
--
-- alter table user_secrets
--   add column if not exists stocks_enabled boolean not null default false;
--
-- 2. Shared cache table for yahoo-finance data (no user_id — public market data):
--
-- create table if not exists stock_cache (
--   ticker      text not null,
--   interval    text not null,
--   data        jsonb not null,
--   fetched_at  timestamptz not null default now(),
--   primary key (ticker, interval)
-- );
-- alter table stock_cache enable row level security;
-- create policy "Authenticated users can read stock cache"
--   on stock_cache for select using (auth.uid() is not null);
-- create policy "Authenticated users can upsert stock cache"
--   on stock_cache for all
--   using (auth.uid() is not null) with check (auth.uid() is not null);
