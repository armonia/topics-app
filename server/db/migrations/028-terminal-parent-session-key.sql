-- Sub-agent orchestrator: stamp the parent (orchestrator) session on a spawned
-- child terminal session. Lets one Claude session own the children it spawned —
-- the ownership guard (assertOwnedChild) enforces that send/read/stop only ever
-- touch a session whose parent_session_key == the caller's own sessionKey — and
-- lets the UI nest children under their parent in the terminal roster.
-- NULL for every human-/chat-created session (the common case).
ALTER TABLE terminal_sessions ADD COLUMN parent_session_key TEXT;
