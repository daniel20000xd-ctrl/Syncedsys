-- Daemon v5 (optional): vector search. Requires pgvector.
-- Apply after daemon_v5.sql, only if you want the vector half of hybrid search.
-- Without it, lib/daemon/search.ts runs FTS-only through the same interface.
-- After applying, set DAEMON_EMBEDDING_MODEL (and DAEMON_EMBEDDING_DIM=768) to switch it
-- on, then run scripts/daemon-backfill-embeddings.ts. Idempotent: safe to re-run.
--
-- The dimension is fixed at 768 here (index requirement). If DAEMON_EMBEDDING_DIM is
-- set to anything else, the code refuses to use the vector path rather than mixing sizes.

create extension if not exists vector with schema extensions;

create table if not exists daemon_embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  source_kind text not null check (source_kind in ('archive', 'active', 'day_entry', 'message', 'thread', 'reflection')),
  source_id uuid not null,
  model text not null,
  content_hash text not null,          -- re-embed when the source text changes
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  unique (source_kind, source_id)
);
create index if not exists daemon_embeddings_hnsw_idx on daemon_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);
alter table daemon_embeddings enable row level security;

-- The text each corpus row is embedded from, with a hash so edits trigger re-embedding.
create or replace view daemon_embedding_sources as
  select 'archive'::text as source_kind, a.id as source_id, a.user_id,
         'title: ' || a.title || ' | text: ' || coalesce(a.content, '') || ' ' || coalesce(a.outcome, '') || ' ' || daemon_tags_text(a.tags) as body
  from daemon_archive a
  union all
  select 'active', a.id, a.user_id, 'title: ' || a.title || ' | text: ' || coalesce(a.content, '') || ' ' || daemon_tags_text(a.tags)
  from daemon_active a
  union all
  select 'day_entry', d.id, d.user_id, 'title: day log ' || d.entry_date || ' | text: ' || d.content
  from daemon_day_entries d
  union all
  select 'message', m.id, m.user_id, 'title: none | text: ' || m.content
  from daemon_interaction_log m where m.call_type <> 'system'
  union all
  select 'thread', t.id, t.user_id, 'title: ' || coalesce(nullif(t.topic, ''), 'none') || ' | text: ' || coalesce(t.question, '')
  from daemon_threads t
  union all
  select 'reflection', r.id, r.user_id, 'title: reflection | text: ' || r.content
  from daemon_reflection_entries r;
revoke all on daemon_embedding_sources from public, anon, authenticated;

-- Rows with no embedding, or whose text changed since embedding. Scans every corpus;
-- fine at personal scale, revisit if the log grows into the hundreds of thousands.
create or replace function daemon_unembedded(p_limit int)
returns table (source_kind text, source_id uuid, user_id uuid, body text, content_hash text)
language sql stable security definer set search_path = public, extensions as $$
  select s.source_kind, s.source_id, s.user_id, s.body, md5(s.body)
  from daemon_embedding_sources s
  left join daemon_embeddings e on e.source_kind = s.source_kind and e.source_id = s.source_id
  where e.id is null or e.content_hash <> md5(s.body)
  limit p_limit;
$$;
revoke all on function daemon_unembedded(int) from public, anon, authenticated;

create or replace function daemon_store_embedding(
  p_user_id uuid, p_kind text, p_id uuid, p_model text, p_hash text, p_embedding text
) returns void
language sql security definer set search_path = public, extensions as $$
  insert into daemon_embeddings (user_id, source_kind, source_id, model, content_hash, embedding)
  values (p_user_id, p_kind, p_id, p_model, p_hash, p_embedding::extensions.vector)
  on conflict (source_kind, source_id) do update
    set model = excluded.model, content_hash = excluded.content_hash, embedding = excluded.embedding, created_at = now();
$$;
revoke all on function daemon_store_embedding(uuid, text, uuid, text, text, text) from public, anon, authenticated;

-- Nearest neighbours by cosine similarity (1 - distance), within the given kinds.
create or replace function daemon_search_vector(p_user_id uuid, p_embedding text, p_kinds text[], p_limit int)
returns table (source_kind text, source_id uuid, similarity real)
language sql stable security definer set search_path = public, extensions as $$
  select e.source_kind, e.source_id, (1 - (e.embedding <=> p_embedding::extensions.vector))::real
  from daemon_embeddings e
  where e.user_id = p_user_id and e.source_kind = any(p_kinds)
  order by e.embedding <=> p_embedding::extensions.vector
  limit p_limit;
$$;
revoke all on function daemon_search_vector(uuid, text, text[], int) from public, anon, authenticated;

-- Similarity for specific rows (FTS hits that weren't in the vector top-k), so hybrid
-- scoring never treats "not retrieved" as "not similar".
create or replace function daemon_vector_similarity(p_embedding text, p_ids uuid[])
returns table (source_kind text, source_id uuid, similarity real)
language sql stable security definer set search_path = public, extensions as $$
  select e.source_kind, e.source_id, (1 - (e.embedding <=> p_embedding::extensions.vector))::real
  from daemon_embeddings e
  where e.source_id = any(p_ids);
$$;
revoke all on function daemon_vector_similarity(text, uuid[]) from public, anon, authenticated;
