-- 053: per-board "auto" concurrency cap. When 1, the dispatcher sizes the
-- max concurrent agents from live machine capacity (CPU cores + load average,
-- see services/dispatch-capacity.ts) instead of the fixed max_agents value.
-- NULL / 0 → manual (use max_agents), preserving every existing board's behaviour.
ALTER TABLE board_settings ADD COLUMN max_agents_auto INTEGER;
