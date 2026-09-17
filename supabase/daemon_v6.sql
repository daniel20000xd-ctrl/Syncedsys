-- Daemon v6: per-call-type model routing + a maintained price table, so switching
-- models is a console edit with no redeploy, and cost accounting survives the switch.
-- Apply after daemon.sql … daemon_v5_vector.sql. Idempotent: safe to re-run.

-- One global row per call type — this subsystem serves a single admin, so there is no
-- per-user model choice. Never written by the daemon runtime; app/daemonActions.ts is
-- the only writer, gated on isAdminEmail.
create table if not exists daemon_model_config (
  call_type text primary key check (call_type in ('input', 'heartbeat', 'reflection', 'meta', 'embedding')),
  model text not null,
  max_output_tokens int,
  note text,
  updated_at timestamptz not null default now()
);
alter table daemon_model_config enable row level security;

-- Seed so a call never runs promptless the moment this deploys. input/heartbeat are
-- deliberately downgraded to a cheaper model right away — that split is the point of
-- this table. reflection/meta keep whatever DAEMON_GEMINI_MODEL was live at deploy
-- (gemini-3.8-flash, per the current .env.local.example / Vercel setting); if you had
-- it set to something else, fix these two rows in the console after applying — SQL
-- can't read your Vercel env to seed this automatically.
insert into daemon_model_config (call_type, model, note) values
  ('input',      'gemini-3.1-flash-lite', 'seeded by daemon_v6.sql — cheap call, downgraded from gemini-3.8-flash'),
  ('heartbeat',   'gemini-3.1-flash-lite', 'seeded by daemon_v6.sql — cheap call, downgraded from gemini-3.8-flash'),
  ('reflection',  'gemini-3.8-flash',      'seeded by daemon_v6.sql — matches DAEMON_GEMINI_MODEL as set at deploy'),
  ('meta',        'gemini-3.8-flash',      'seeded by daemon_v6.sql — matches DAEMON_GEMINI_MODEL as set at deploy'),
  ('embedding',   'gemini-embedding-2',    'seeded by daemon_v6.sql — matches DAEMON_EMBEDDING_MODEL as set at deploy')
on conflict (call_type) do nothing;

-- Maintained by hand in /daemon/models. This is the one place a typed number affects a
-- safety bound — isOverBudget() prices every call from this table, so the console warns
-- on save that it changes what the cost cap measures.
create table if not exists daemon_model_prices (
  model text primary key,
  input_per_mtok numeric not null,
  output_per_mtok numeric not null,
  cached_input_per_mtok numeric,
  effective_from date,
  note text,
  updated_at timestamptz not null default now()
);
alter table daemon_model_prices enable row level security;

-- USD per 1M tokens, standard paid tier, prompts ≤200k, as of 2026-09 — the table that
-- used to be hardcoded in lib/daemon/usage.ts, moved here verbatim. Seeded for every
-- model on that old list, not only the ones daemon_model_config points at above, so
-- switching within this already-vetted set never strands cost accounting. A model
-- outside this set needs a price row added by hand before it's used, or every call on
-- it records cost_usd = null (never a guessed rate, never a silent zero).
insert into daemon_model_prices (model, input_per_mtok, output_per_mtok, note) values
  ('gemini-3.8-flash',       0.75,  3.75,  'introductory rate; doubles to 1.50/7.50 on 2027-01-01'),
  ('gemini-3.7-flash',       0.75,  3.75,  'introductory rate; doubles to 1.50/7.50 on 2027-01-01'),
  ('gemini-3.6-flash',       0.75,  3.75,  'introductory rate; doubles to 1.50/7.50 on 2027-01-01'),
  ('gemini-3.5-flash-lite',  0.30,  2.50,  null),
  ('gemini-3.5-flash',       1.50,  9.00,  null),
  ('gemini-3.1-flash-lite',  0.25,  1.50,  null),
  ('gemini-3.1-pro-preview', 2.00,  12.00, 'for prompts ≤200k tokens; 4.00/18.00 above that (not modelled per-call here)'),
  ('gemini-2.5-flash-lite',  0.10,  0.40,  null),
  ('gemini-2.5-flash',       0.30,  2.50,  null),
  ('gemini-2.5-pro',         1.25,  10.00, 'for prompts ≤200k tokens; 2.50/15.00 above that (not modelled per-call here)'),
  ('gemini-embedding-2',     0.20,  0.00,  'text input only — embeddings have no output tokens')
on conflict (model) do nothing;

-- A price-less model must be able to record "unknown cost", not a guessed or zero one —
-- a silent zero would quietly disable the daily cap. daemon_usage.model (v1) already
-- records the model actually used per call; only the cost column needs to allow null.
alter table daemon_usage alter column cost_usd drop not null;

create index if not exists daemon_usage_model_idx on daemon_usage(model, created_at);
