-- 054: global app-settings store (env-var audit, Phase B).
--
-- Promotes behaviour TOGGLES that used to live only in env vars into a
-- singleton settings row the user can edit from the UI. Every column is
-- NULLABLE and starts NULL, so resolution is `setting ?? env ?? default`:
-- until the user sets a value from Settings, behaviour is IDENTICAL to today
-- (env → built-in default). Secrets/bootstrap/build/test/debug envs are NOT
-- promoted and never touch this table — see docs/ENV.md.
--
-- Single-row table (id fixed to 1) rather than a key/value bag so each toggle
-- is a typed, self-documenting column and migrations stay greppable.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ai_provider TEXT,                    -- default provider: claude|openai|openclaw|claude-code|codex
  claude_model TEXT,                   -- claude + claude-code model id (see CLAUDE_MODEL)
  claude_max_tokens INTEGER,           -- claude max output tokens
  claude_effort TEXT,                  -- default claude effort tier (low|medium|high|xhigh|max)
  openai_model TEXT,
  openai_max_tokens INTEGER,
  codex_model TEXT,
  codex_reasoning_effort TEXT,         -- none|minimal|low|medium|high|xhigh|ultra
  claude_code_permission_mode TEXT,
  codex_approval_mode TEXT,            -- auto|full-access
  claude_code_enabled INTEGER,         -- 0|1|NULL (NULL = auto-detect CLI)
  updated_at TEXT
);

INSERT OR IGNORE INTO app_settings (id) VALUES (1);
