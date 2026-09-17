-- Daemon v2: threads, incremental day log, operating notes, links.
-- Apply after supabase/daemon.sql. Idempotent: safe to re-run.

create table if not exists daemon_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  opened_by text not null check (opened_by in ('ai', 'me')),
  topic text not null default '',
  question text,
  reasoning text,
  referenced_active_ids uuid[] not null default '{}',
  referenced_archive_ids uuid[] not null default '{}',
  referenced_log_dates date[] not null default '{}',
  expects_reply boolean not null default false,
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  opened_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text
);
create index if not exists daemon_threads_activity_idx on daemon_threads(user_id, last_activity_at desc);
create index if not exists daemon_threads_status_idx on daemon_threads(status);
alter table daemon_threads enable row level security;

create table if not exists daemon_day_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  entry_date date not null,
  call_type text not null check (call_type in ('input', 'heartbeat', 'reflection')),
  thread_id uuid references daemon_threads(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists daemon_day_entries_date_idx on daemon_day_entries(user_id, entry_date, created_at);
alter table daemon_day_entries enable row level security;

create table if not exists daemon_operating_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  version int not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (user_id, version)
);
alter table daemon_operating_notes enable row level security;

create table if not exists daemon_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  from_kind text not null check (from_kind in ('active', 'archive')),
  from_id uuid not null,
  to_kind text not null check (to_kind in ('active', 'archive')),
  to_id uuid not null,
  why text not null default '',
  created_at timestamptz not null default now(),
  unique (from_id, to_id)
);
create index if not exists daemon_links_to_idx on daemon_links(to_id);
alter table daemon_links enable row level security;

alter table daemon_interaction_log add column if not exists thread_id uuid references daemon_threads(id) on delete set null;
create index if not exists daemon_interaction_log_thread_idx on daemon_interaction_log(thread_id, created_at);

alter table daemon_pending_input add column if not exists thread_id uuid references daemon_threads(id) on delete set null;

-- Set when a pinging heartbeat with expects_reply targets the item; cleared when the
-- thread gets a reply or closes.
alter table daemon_active add column if not exists awaiting_report_thread_id uuid references daemon_threads(id) on delete set null;
alter table daemon_active add column if not exists awaiting_report_since timestamptz;

-- One-time copy of the v1 R2 day-log files from daemon/reflection/ to daemon/daylog/.
alter table daemon_state add column if not exists daylog_migrated_at timestamptz;

-- Latest message per thread, for the thread list.
create or replace function daemon_thread_previews(thread_ids uuid[])
returns table (thread_id uuid, direction text, content text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (l.thread_id) l.thread_id, l.direction, l.content, l.created_at
  from daemon_interaction_log l
  where l.thread_id = any(thread_ids) and l.call_type <> 'system'
  order by l.thread_id, l.created_at desc;
$$;
revoke all on function daemon_thread_previews(uuid[]) from public, anon, authenticated;
