-- Per-task model override for the dispatched agent topic.
-- NULL = auto (the provider's default model). Set from the board composer's
-- model chip; the dispatcher copies it onto the detached topic at spawn.
ALTER TABLE tasks ADD COLUMN model TEXT;
