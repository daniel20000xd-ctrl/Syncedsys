create table workspace_photos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  filename      text not null,
  r2_key        text not null unique,
  mime_type     text not null,
  size_bytes    bigint not null,
  created_at    timestamptz default now() not null,
  expires_at    timestamptz,
  is_saved      boolean default false not null,
  project_tag   text,
  width         int,
  height        int
);

alter table workspace_photos enable row level security;
-- No RLS policies — all access goes through service-role API routes.

create index workspace_photos_user_created_idx on workspace_photos(user_id, created_at desc);
create index workspace_photos_expires_at_idx on workspace_photos(expires_at) where expires_at is not null;
