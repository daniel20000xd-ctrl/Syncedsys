-- ── Personas ──────────────────────────────────────────────────────────────────
-- A persona is the highest-level container: a board row flagged is_persona=true
-- living at parent_id=NULL (the true root of the tree). Every user-facing
-- top-level tab becomes a child of a persona (parent_id=<persona>). Switching
-- persona just swaps which subtree is shown on screen.
--
-- Personas are ordinary `boards` rows, so the existing RLS policy
-- ("Users own their boards") already scopes them per-user. No new policy needed.
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it once in the
-- Supabase SQL editor on the live project BEFORE deploying the persona feature.

-- 1. Flag column + a partial index for fast persona lookups per user.
alter table boards add column if not exists is_persona boolean not null default false;
create index if not exists boards_persona_idx on boards(user_id) where is_persona;

-- 2. A persona must be a root (no parent). Prevents nesting personas.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'persona_is_root') then
    alter table boards add constraint persona_is_root
      check (not is_persona or parent_id is null);
  end if;
end $$;

-- 3. Block direct deletion of a persona that still has children, so the
--    ON DELETE CASCADE on boards.parent_id can never silently wipe a workspace.
--    (Empty personas can be deleted; deletePersona() removes children first.)
create or replace function prevent_nonempty_persona_delete() returns trigger as $$
begin
  if old.is_persona and exists (select 1 from boards where parent_id = old.id) then
    raise exception 'Cannot delete persona % while it still has boards', old.id;
  end if;
  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_nonempty_persona_delete on boards;
create trigger trg_prevent_nonempty_persona_delete
  before delete on boards
  for each row execute function prevent_nonempty_persona_delete();

-- 4. Backfill. For every user who still has un-migrated top-level boards
--    (parent_id IS NULL and not already a persona), create one "Personal"
--    persona and reparent those boards under it. The is_persona=false guard in
--    both the cursor and the UPDATE makes a re-run a no-op.
do $$
declare
  u       record;
  pid     uuid;
  nextpos int;
begin
  for u in
    select distinct user_id
    from boards
    where parent_id is null and is_persona = false
  loop
    -- Reuse an existing persona if the user already has one (handles a
    -- half-applied migration or personas created via the app), otherwise create
    -- one at the next free top-level position. No duplicates, no collisions.
    select id into pid
    from boards
    where user_id = u.user_id and is_persona = true
    order by tab_position, created_at
    limit 1;

    if pid is null then
      select coalesce(max(tab_position), -1) + 1 into nextpos
      from boards
      where user_id = u.user_id and parent_id is null and is_persona = true;

      insert into boards (user_id, name, color, mode, is_persona, parent_id, tab_position)
      values (u.user_id, 'Personal', '#6366f1', 'classic', true, null, coalesce(nextpos, 0))
      returning id into pid;
    end if;

    update boards
    set parent_id = pid
    where user_id = u.user_id
      and parent_id is null
      and is_persona = false;
  end loop;
end $$;
