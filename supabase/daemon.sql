-- Daemon: scheduled AI that prompts the user (see lib/daemon/*, app/api/daemon/*).
-- Isolated subsystem: every table is daemon_-prefixed. Service-role access only
-- (RLS enabled with no policies, so anon/authenticated clients see nothing).
-- Idempotent: safe to re-run.

create table if not exists daemon_state (
  id int primary key default 1 check (id = 1),
  user_id uuid references auth.users(id) on delete set null,
  is_processing boolean not null default false,
  holder text check (holder in ('input', 'heartbeat', 'reflection')),
  lock_acquired_at timestamptz,
  next_wake_time timestamptz,
  last_heartbeat_at timestamptz,
  last_reflection_at timestamptz,
  enabled boolean not null default true,
  shadow_mode boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table daemon_state add column if not exists last_reflection_day date;
alter table daemon_state add column if not exists budget_alert_day date;
alter table daemon_state add column if not exists last_failure_alert_at timestamptz;
insert into daemon_state (id) values (1) on conflict (id) do nothing;
alter table daemon_state enable row level security;

create table if not exists daemon_active (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  type text not null check (type in ('task', 'problem', 'note')),
  title text not null,
  content text not null default '',
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'blocked')),
  deadline timestamptz,
  tags text[] not null default '{}',
  reschedule_count int not null default 0,
  last_nudged_at timestamptz,
  created_at timestamptz not null default now(),
  last_touched timestamptz not null default now()
);
create index if not exists daemon_active_status_idx on daemon_active(status);
alter table daemon_active enable row level security;

create table if not exists daemon_archive (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  original_id uuid,
  type text not null,
  title text not null,
  content text not null default '',
  tags text[] not null default '{}',
  outcome text,
  why_archived text,
  depth int not null default 1,
  archived_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists daemon_archive_tags_idx on daemon_archive using gin(tags);
alter table daemon_archive enable row level security;

create table if not exists daemon_interaction_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  call_type text not null check (call_type in ('input', 'heartbeat', 'reflection', 'system')),
  content text not null,
  push_sent boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists daemon_interaction_log_created_idx on daemon_interaction_log(created_at desc);
alter table daemon_interaction_log enable row level security;

create table if not exists daemon_pending_input (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  content text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists daemon_pending_input_unprocessed_idx
  on daemon_pending_input(received_at) where processed_at is null;
alter table daemon_pending_input enable row level security;

create table if not exists daemon_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  device_token text unique not null,
  platform text not null default 'ios',
  environment text not null default 'production' check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now()
);
alter table daemon_push_tokens enable row level security;

create table if not exists daemon_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  call_type text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric not null default 0,
  error text,
  attempt int not null default 1,
  created_at timestamptz not null default now()
);
alter table daemon_usage add column if not exists note text;
create index if not exists daemon_usage_created_idx on daemon_usage(created_at);
alter table daemon_usage enable row level security;

-- Nightly: every archive row not promoted this cycle sinks one level deeper.
create or replace function daemon_bump_archive_depth(exclude_ids uuid[])
returns void language sql security definer set search_path = public as $$
  update daemon_archive set depth = depth + 1
  where not (id = any(coalesce(exclude_ids, '{}'::uuid[])));
$$;
revoke all on function daemon_bump_archive_depth(uuid[]) from public, anon, authenticated;
