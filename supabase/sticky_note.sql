-- Single-list sticky-note items, synced to the desktop widget (syncedsys-sticky)
-- and, eventually, the iOS app. Idempotent: safe to re-run.
create table if not exists sticky_note_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  text text not null,
  done boolean not null default false,
  position double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table sticky_note_items enable row level security;
drop policy if exists "users manage their sticky note items" on sticky_note_items;
create policy "users manage their sticky note items" on sticky_note_items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists sticky_note_items_user_idx on sticky_note_items(user_id, position);

-- Realtime, so any connected client (desktop, future iOS) gets live updates
alter publication supabase_realtime add table sticky_note_items;
