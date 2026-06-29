-- 030-terminal-session-name-source.sql: track HOW a terminal session's name was
-- set, so auto-naming never clobbers a label the user typed.
--
-- A Claude Code chat tab is auto-labelled from the session's evolving topic (the
-- `ai-title` Claude Code writes into its transcript). To make that coexist with
-- manual renames we record the name's provenance:
--   'default' — the generated "Terminal N"; free to auto-relabel.
--   'auto'    — set by the auto-namer; still refreshable as the topic evolves.
--   'user'    — a manual rename; frozen, auto-naming leaves it alone.
--
-- Existing rows whose name ISN'T a "Terminal N" default are assumed to be
-- user-chosen, so this one-time upgrade won't suddenly relabel them.
ALTER TABLE terminal_sessions ADD COLUMN name_source TEXT NOT NULL DEFAULT 'default';
UPDATE terminal_sessions SET name_source = 'user' WHERE name NOT GLOB 'Terminal [0-9]*';
