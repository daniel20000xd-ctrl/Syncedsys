-- ── Google OAuth tokens (shared by all Google integrations) ──────────────────
-- One row per user. Holds the OAuth tokens for the user's connected Google
-- account, used by every Google integration (Calendar, Sheets, Docs).
--
-- Both access_token and refresh_token are encrypted at rest with AES-256-GCM
-- (lib/crypto encryptSecret) BEFORE they ever reach this table — these columns
-- never hold plaintext. All writes go through lib/google/auth.ts on the
-- service-role client, which stamps the trusted, server-derived user_id; the
-- RLS policy below scopes any direct access to the owner's own row.
--
-- Run once in the Supabase SQL editor on the live project. Idempotent.

create table if not exists user_google_tokens (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        references auth.users(id) on delete cascade not null unique,
  access_token  text        not null,                 -- AES-256-GCM ciphertext, never plaintext
  refresh_token text        not null,                 -- AES-256-GCM ciphertext, never plaintext
  scopes        text[]      not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists user_google_tokens_user_idx on user_google_tokens(user_id);

alter table user_google_tokens enable row level security;

-- Users may read and write only their own row.
drop policy if exists "users manage their google tokens" on user_google_tokens;
create policy "users manage their google tokens" on user_google_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
