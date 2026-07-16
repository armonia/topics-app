-- 052: per-board default model for dispatched agents.
-- NULL / 'auto' → the classifier picks a model per task (prior behaviour). A
-- concrete model id pins every dispatch on this board to it. An explicit
-- per-task model (task.model) still wins over the board default.
ALTER TABLE board_settings ADD COLUMN dispatch_model TEXT;
