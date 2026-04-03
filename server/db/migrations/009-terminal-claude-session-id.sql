-- Add claude_session_id to terminal_sessions for resume support
ALTER TABLE terminal_sessions ADD COLUMN claude_session_id TEXT;
