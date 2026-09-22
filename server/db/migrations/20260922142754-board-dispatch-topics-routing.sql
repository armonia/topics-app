-- AICTRL-05: BoardSettingsPanel needs its own default for the routing switch,
-- same as it already has one for the dispatch model (052). NULL means "never
-- set on this board": the dispatcher falls back to the task's own value, then
-- to the legacy `topics:<model>` reading, same order as everywhere else.
ALTER TABLE board_settings ADD COLUMN dispatch_topics_routing INTEGER CHECK (dispatch_topics_routing IN (0, 1));
