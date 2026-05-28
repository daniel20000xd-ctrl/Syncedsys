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
  created_at timestamptz default now()
);

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

-- Indexes
create index on boards(user_id);
create index on boards(parent_id);
create index on account_links(owner_id);
create index on account_links(member_id);
create index on lists(board_id);
create index on cards(list_id);

-- Migration: run these if upgrading an existing database (skip if running schema fresh)
-- alter table boards add column if not exists parent_id uuid references boards(id) on delete cascade;
-- alter table boards add column if not exists tab_position integer not null default 0;
-- create index if not exists boards_parent_id_idx on boards(parent_id);
-- alter table boards add column if not exists content text;
