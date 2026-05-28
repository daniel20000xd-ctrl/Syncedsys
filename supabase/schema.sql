-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Boards
create table boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  color text not null default '#0079bf',
  created_at timestamptz default now()
);

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
  created_at timestamptz default now()
);

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

-- Indexes
create index on boards(user_id);
create index on lists(board_id);
create index on cards(list_id);
