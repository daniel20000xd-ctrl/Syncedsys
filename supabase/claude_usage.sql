-- ── Claude usage ledger (platform-credit billing) ────────────────────────────
-- One row per server-side Claude request. key_source 'platform' = ran on the
-- owner's ANTHROPIC_API_KEY and is billable to the user at markup; 'user' = ran on
-- the user's own key (cost_usd 0, billable false), kept only for their visibility.
--
-- This ledger is the billing source of truth, so it is APPEND-ONLY for end users:
-- they may read their own rows but cannot insert, edit, or delete them. All writes
-- happen server-side through the service-role client (recordClaudeUsage), which
-- bypasses RLS and stamps the trusted, server-derived user_id.
--
-- Run once in the Supabase SQL editor on the live project. Idempotent.

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

-- Read-only for the owner. No insert/update/delete policy: those default-deny under
-- RLS, so a billed user cannot fabricate or erase usage. Service-role writes bypass
-- RLS; the admin billing view also reads via the service role.
drop policy if exists "users own their claude usage" on claude_usage;
drop policy if exists "claude usage select own" on claude_usage;
create policy "claude usage select own" on claude_usage
  for select using (user_id = auth.uid());
