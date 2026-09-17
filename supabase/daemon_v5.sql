-- Daemon v5: recall (full-text search over every daemon corpus), thread findings,
-- searchable reflection entries, thread scratchpad, recall event log.
-- Apply after daemon.sql … daemon_v4.sql. Idempotent: safe to re-run.
--
-- Vector search is in a separate, optional file (daemon_v5_vector.sql) because it
-- needs the pgvector extension. Everything here works without it.
--
-- FTS config: 'english' below must match FTS_CONFIG in lib/daemon/search.ts. Changing
-- language means changing that constant AND regenerating these columns in a new migration.

-- array_to_string is only STABLE; generated columns need IMMUTABLE. Tags are plain text[].
create or replace function daemon_tags_text(tags text[]) returns text
language sql immutable parallel safe as $$ select coalesce(array_to_string(tags, ' '), '') $$;

-- ── searchable reflection entries (R2 stays the lossless archive) ────────────────
create table if not exists daemon_reflection_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  entry_date date,
  source text not null default 'reflection' check (source in ('reflection', 'meta', 'backfill')),
  content text not null,
  -- set only by the R2 backfill, so re-running it never duplicates rows
  backfill_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists daemon_reflection_entries_created_idx on daemon_reflection_entries(user_id, created_at desc);
alter table daemon_reflection_entries enable row level security;

-- ── thread scratchpad ────────────────────────────────────────────────────────────
alter table daemon_threads add column if not exists working_state text;
alter table daemon_threads add column if not exists open_question text;

-- Per-message provenance: why the daemon said this, and its working state at the time.
-- working_state on the thread is rewritten each turn; this keeps every earlier version.
alter table daemon_interaction_log add column if not exists reasoning text;
alter table daemon_interaction_log add column if not exists working_state text;

-- ── model-requested searches, delivered on the next call in the thread ───────────
create table if not exists daemon_thread_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  thread_id uuid not null references daemon_threads(id) on delete cascade,
  query text not null,
  why text,
  results jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by text
);
create index if not exists daemon_thread_findings_pending_idx on daemon_thread_findings(thread_id) where consumed_at is null;
alter table daemon_thread_findings enable row level security;

-- ── recall events: every retrieval, for the console's quality metrics ────────────
create table if not exists daemon_recall_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  mode text not null check (mode in ('prefetch', 'search', 'reflection')),
  thread_id uuid references daemon_threads(id) on delete set null,
  query text not null,
  signals text not null,               -- 'fts' or 'fts+vector'
  hits jsonb not null default '[]'::jsonb,   -- [{ kind, id, score, why_matched }]
  created_at timestamptz not null default now()
);
create index if not exists daemon_recall_events_created_idx on daemon_recall_events(user_id, created_at);
alter table daemon_recall_events enable row level security;

-- ── full-text columns ────────────────────────────────────────────────────────────
alter table daemon_active add column if not exists fts tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', daemon_tags_text(tags)), 'B') ||
  setweight(to_tsvector('english', coalesce(content, '')), 'C')
) stored;
create index if not exists daemon_active_fts_idx on daemon_active using gin(fts);

alter table daemon_archive add column if not exists fts tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', daemon_tags_text(tags)), 'B') ||
  setweight(to_tsvector('english', coalesce(content, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(outcome, '') || ' ' || coalesce(why_archived, '')), 'C')
) stored;
create index if not exists daemon_archive_fts_idx on daemon_archive using gin(fts);

alter table daemon_day_entries add column if not exists fts tsvector generated always as (
  to_tsvector('english', coalesce(content, ''))
) stored;
create index if not exists daemon_day_entries_fts_idx on daemon_day_entries using gin(fts);

alter table daemon_interaction_log add column if not exists fts tsvector generated always as (
  to_tsvector('english', coalesce(content, ''))
) stored;
create index if not exists daemon_interaction_log_fts_idx on daemon_interaction_log using gin(fts);

alter table daemon_threads add column if not exists fts tsvector generated always as (
  setweight(to_tsvector('english', coalesce(topic, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(question, '')), 'B')
) stored;
create index if not exists daemon_threads_fts_idx on daemon_threads using gin(fts);

alter table daemon_reflection_entries add column if not exists fts tsvector generated always as (
  to_tsvector('english', coalesce(content, ''))
) stored;
create index if not exists daemon_reflection_entries_fts_idx on daemon_reflection_entries using gin(fts);

-- ── FTS search across corpora ────────────────────────────────────────────────────
-- Query terms are OR-ed (people describe the same thing in different words), so
-- ranking, not matching, decides relevance. Returns the raw ts_rank_cd plus how many
-- distinct query lexemes each row matched; lib/daemon/search.ts turns that into 0–1.
-- Excerpts are verbatim text around the match (no highlight markers).
create or replace function daemon_search_fts(
  p_user_id uuid,
  p_query text,
  p_config regconfig,
  p_kinds text[],
  p_since timestamptz,
  p_before timestamptz,
  p_exclude_thread uuid,
  p_limit int
)
returns table (kind text, id uuid, title text, excerpt text, created_at timestamptz, rank real, matched int, total int, matched_terms text[])
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  q tsquery;
  lexemes text[];
  hl text := 'StartSel="",StopSel="",MaxWords=35,MinWords=12,MaxFragments=1,FragmentDelimiter=" … "';
begin
  lexemes := array(select distinct unnest(tsvector_to_array(to_tsvector(p_config, coalesce(p_query, '')))));
  if cardinality(lexemes) = 0 then
    return;
  end if;
  q := array_to_string(array(select quote_literal(l) from unnest(lexemes) l), ' | ')::tsquery;

  return query
  with hits as (
    select 'archive'::text as kind, a.id, a.title,
           coalesce(nullif(a.content, ''), a.outcome, a.title) as body,
           a.archived_at as created_at, a.fts
    from daemon_archive a
    where 'archive' = any(p_kinds) and a.user_id = p_user_id and a.fts @@ q
    union all
    select 'active', a.id, a.title, coalesce(nullif(a.content, ''), a.title), a.created_at, a.fts
    from daemon_active a
    where 'active' = any(p_kinds) and a.user_id = p_user_id and a.fts @@ q
    union all
    select 'day_entry', d.id, 'day log ' || d.entry_date || ' (' || d.call_type || ')', d.content, d.created_at, d.fts
    from daemon_day_entries d
    where 'day_entry' = any(p_kinds) and d.user_id = p_user_id and d.fts @@ q
      and (p_exclude_thread is null or d.thread_id is distinct from p_exclude_thread)
    union all
    select 'message', m.id, case when m.direction = 'in' then 'you said' else 'daemon said' end, m.content, m.created_at, m.fts
    from daemon_interaction_log m
    where 'message' = any(p_kinds) and m.user_id = p_user_id and m.call_type <> 'system' and m.fts @@ q
      and (p_exclude_thread is null or m.thread_id is distinct from p_exclude_thread)
    union all
    select 'thread', t.id, coalesce(nullif(t.topic, ''), '(thread)'), coalesce(t.question, t.topic, ''), t.opened_at, t.fts
    from daemon_threads t
    where 'thread' = any(p_kinds) and t.user_id = p_user_id and t.fts @@ q
      and (p_exclude_thread is null or t.id <> p_exclude_thread)
    union all
    select 'reflection', r.id, 'reflection ' || coalesce(r.entry_date::text, to_char(r.created_at, 'YYYY-MM-DD')), r.content, r.created_at, r.fts
    from daemon_reflection_entries r
    where 'reflection' = any(p_kinds) and r.user_id = p_user_id and r.fts @@ q
  ),
  scored as (
    select h.*, ts_rank_cd(h.fts, q) as rank,
           array(select l from unnest(tsvector_to_array(h.fts)) l where l = any(lexemes)) as terms
    from hits h
    where (p_since is null or h.created_at >= p_since)
      and (p_before is null or h.created_at < p_before)
  )
  select s.kind, s.id, s.title,
         ts_headline(p_config, s.body, q, hl) as excerpt,
         s.created_at, s.rank, cardinality(s.terms), cardinality(lexemes), s.terms
  from scored s
  order by cardinality(s.terms) desc, s.rank desc
  limit p_limit;
end;
$$;
revoke all on function daemon_search_fts(uuid, text, regconfig, text[], timestamptz, timestamptz, uuid, int) from public, anon, authenticated;
