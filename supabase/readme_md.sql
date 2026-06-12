-- Add per-board README field.
-- Idempotent: safe to re-run.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS readme_md TEXT;
