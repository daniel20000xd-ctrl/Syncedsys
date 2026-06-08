-- Add user-editable description to each photo
alter table workspace_photos add column if not exists description text;

-- Per-user photo library settings (pause_deletion etc.)
create table if not exists photo_library_settings (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  pause_deletion boolean not null default false,
  updated_at     timestamptz default now() not null
);

alter table photo_library_settings enable row level security;
-- No RLS policies — all access goes through service-role API routes
