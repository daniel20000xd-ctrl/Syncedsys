create table gate_requests (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  attempt_type text not null,
  status       text not null default 'pending',
  created_at   timestamptz default now(),
  actioned_at  timestamptz
);

alter table gate_requests enable row level security;

-- Decoy site inserts without authentication
create policy "anon_insert_gate_requests"
  on gate_requests for insert
  to anon
  with check (true);

-- All admin reads and updates go through the service-role client (bypasses RLS).
