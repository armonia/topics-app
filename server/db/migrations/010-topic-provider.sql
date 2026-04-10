-- Add optional provider field to topics (e.g. "openclaw", "claude"). NULL = use default.
ALTER TABLE topics ADD COLUMN provider TEXT;
