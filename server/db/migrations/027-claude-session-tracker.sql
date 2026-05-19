-- 027-claude-session-tracker.sql: extend claude_code_sessions with the
-- canonical Claude Code lifecycle phase + recovery metadata. See
-- openspec/changes/claude-session-tracker for the design.
--
-- All columns are additive and either NOT NULL with a default, or NULL —
-- existing rows survive untouched. The default phase 'dormant' is correct
-- for rows created before this migration: their PTYs have long since
-- exited and they exist only to support `claude --resume`.

ALTER TABLE claude_code_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'dormant';
ALTER TABLE claude_code_sessions ADD COLUMN phase_updated_at TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN jsonl_path TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN jsonl_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claude_code_sessions ADD COLUMN pending_approval_json TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN last_tool_json TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN last_hook_at TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claude_code_sessions ADD COLUMN error_json TEXT;

CREATE INDEX IF NOT EXISTS idx_claude_code_sessions_phase ON claude_code_sessions(phase);
CREATE INDEX IF NOT EXISTS idx_claude_code_sessions_phase_updated ON claude_code_sessions(phase_updated_at);
