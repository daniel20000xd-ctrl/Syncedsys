-- Short-lived authorization codes for the MCP OAuth 2.0 PKCE flow.
-- Each code is single-use and expires in 10 minutes. The token endpoint consumes
-- the code, verifies PKCE, and returns a normal sk_ssys_ PAT from mcp_tokens.

create table if not exists mcp_oauth_codes (
  code         text        primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  code_challenge text      not null,
  redirect_uri text        not null,
  client_id    text        not null,
  expires_at   timestamptz not null,
  used_at      timestamptz
);

create index if not exists mcp_oauth_codes_expires_at_idx on mcp_oauth_codes(expires_at);

alter table mcp_oauth_codes enable row level security;
-- No user-visible RLS policies — all access is via the service-role key.
