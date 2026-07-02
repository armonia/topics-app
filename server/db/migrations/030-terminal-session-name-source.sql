-- 030-terminal-session-name-source.sql: track HOW a terminal session's name was
-- set, so auto-naming never clobbers a label the user typed.
--
-- A Claude Code chat tab is auto-labelled from the session's evolving topic (the
-- `ai-title` Claude Code writes into its transcript). To make that coexist with
-- manual renames we record the name's provenance:
--   'default' — a generated name: "Terminal N" OR an agent label such as
--               "Claude Code" / "Shell" / "Codex"; free to auto-relabel.
--   'auto'    — set by the auto-namer; still refreshable as the topic evolves.
--   'user'    — a manual rename; frozen, auto-naming leaves it alone.
--
-- Existing rows whose name is neither a "Terminal N" default NOR a generic agent
-- label (Shell / Claude Code / Codex / Claude Code Team — see client
-- terminalAgents.ts TERMINAL_AGENT_LABELS) are assumed to be a manual rename, so
-- this one-time upgrade marks only those 'user'. Every default name (including
-- the "Claude Code" a fresh chat is born with) stays auto-renameable — without
-- this, auto-naming would never touch a Claude Code session, since its default
-- label isn't "Terminal N".
ALTER TABLE terminal_sessions ADD COLUMN name_source TEXT NOT NULL DEFAULT 'default';
UPDATE terminal_sessions SET name_source = 'user'
 WHERE name NOT GLOB 'Terminal [0-9]*'
   AND name NOT IN ('Shell', 'Claude Code', 'Codex', 'Claude Code Team');
