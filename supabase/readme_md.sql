-- Per-board README field + opt-in flag.
-- Idempotent: safe to re-run.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS readme_md TEXT;

-- README is opt-in per board (off by default). Surfaced as a checkbox in the
-- board properties panel for every mode except database.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS readme_enabled BOOLEAN NOT NULL DEFAULT false;
