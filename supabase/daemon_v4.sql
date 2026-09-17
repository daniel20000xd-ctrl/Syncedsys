-- Daemon v4: prompts in the database, prompt provenance on usage, memory events,
-- publish functions for the admin console.
-- Apply after daemon.sql, daemon_v2.sql and daemon_v3.sql. Idempotent: safe to re-run.

-- Append-only, versioned per kind. Exactly one active row per kind. Rows are never
-- updated except to clear is_active when a newer version is published, and never deleted.
create table if not exists daemon_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  kind text not null check (kind in ('system', 'input', 'heartbeat', 'reflection', 'meta')),
  version int not null,
  content text not null,
  is_active boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  unique (kind, version)
);
create unique index if not exists daemon_prompts_one_active_idx on daemon_prompts(kind) where is_active;
alter table daemon_prompts enable row level security;

-- Seed: the placeholder from lib/daemon/systemPrompt.ts, so calls have an active
-- system prompt the moment this deploys.
insert into daemon_prompts (user_id, kind, version, content, is_active, note)
select (select user_id from daemon_state where id = 1), 'system', 1, 'TODO — written later', true,
  'seeded from lib/daemon/systemPrompt.ts by daemon_v4.sql'
where not exists (select 1 from daemon_prompts where kind = 'system');

-- Provenance: which prompt versions produced each call. Null on warning rows and on
-- dry runs with an override prompt.
alter table daemon_usage add column if not exists system_prompt_version int;
alter table daemon_usage add column if not exists call_prompt_version int;
alter table daemon_usage add column if not exists dry_run boolean not null default false;
create index if not exists daemon_usage_call_type_idx on daemon_usage(call_type, created_at);

-- Journey of an item in and out of mind. item_id is the active-item lineage id
-- (daemon_archive.original_id for archived items). Written by the daemon's own
-- apply code, never edited.
create table if not exists daemon_memory_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  item_id uuid not null,
  event text not null check (event in ('created', 'archived', 'promoted')),
  call_type text,
  archive_id uuid,
  why text,
  outcome text,
  created_at timestamptz not null default now()
);
create index if not exists daemon_memory_events_item_idx on daemon_memory_events(item_id, created_at);
alter table daemon_memory_events enable row level security;

-- Backfill 'archived' events from archive rows that existed before event logging.
insert into daemon_memory_events (user_id, item_id, event, archive_id, why, outcome, created_at)
select a.user_id, a.original_id, 'archived', a.id, a.why_archived, a.outcome, a.archived_at
from daemon_archive a
where a.original_id is not null
  and not exists (select 1 from daemon_memory_events e where e.archive_id = a.id and e.event = 'archived');

create index if not exists daemon_day_entries_thread_idx on daemon_day_entries(thread_id);
create index if not exists daemon_threads_opened_idx on daemon_threads(opened_at desc);

-- Publishing is one transaction: next version, deactivate the old row, insert the new
-- active row. There is never a moment with no active prompt.
create or replace function daemon_publish_prompt(p_kind text, p_content text, p_note text, p_user_id uuid)
returns daemon_prompts language plpgsql security definer set search_path = public as $$
declare
  next_version int;
  inserted daemon_prompts;
begin
  if coalesce(btrim(p_content), '') = '' then
    raise exception 'prompt content must not be empty';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'a note is required';
  end if;
  perform pg_advisory_xact_lock(hashtext('daemon_prompts:' || p_kind));
  select coalesce(max(version), 0) + 1 into next_version from daemon_prompts where kind = p_kind;
  update daemon_prompts set is_active = false where kind = p_kind and is_active;
  insert into daemon_prompts (user_id, kind, version, content, is_active, note)
  values (p_user_id, p_kind, next_version, p_content, true, p_note)
  returning * into inserted;
  return inserted;
end;
$$;
revoke all on function daemon_publish_prompt(text, text, text, uuid) from public, anon, authenticated;

alter table daemon_self_description add column if not exists note text;

create or replace function daemon_publish_self_description(p_content text, p_note text, p_user_id uuid)
returns daemon_self_description language plpgsql security definer set search_path = public as $$
declare
  inserted daemon_self_description;
begin
  if coalesce(btrim(p_content), '') = '' then
    raise exception 'self-description must not be empty';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'a note is required';
  end if;
  perform pg_advisory_xact_lock(hashtext('daemon_self_description'));
  insert into daemon_self_description (user_id, version, content, note)
  values (p_user_id, (select coalesce(max(version), 0) + 1 from daemon_self_description), p_content, p_note)
  returning * into inserted;
  return inserted;
end;
$$;
revoke all on function daemon_publish_self_description(text, text, uuid) from public, anon, authenticated;
