-- MCP fleet scoping for dispatched agent sessions (token-budget control).
--
-- A Claude Code session spawned by Topics inherits EVERY MCP server from the
-- user's ~/.claude.json (exa, context7, gateway with its mounted children…):
-- tens of thousands of tool-schema tokens re-read on every API call of every
-- turn. A board agent needs the `topics` bridge (task tools + browser
-- verification) — web research stays available via the CLI's built-in
-- WebSearch/WebFetch, which are not MCP.
--
-- topics.mcp_policy (NULL = inherit like today, 'bridge-only' = only the
-- topics bridge, spawned with a dispatch-reduced tool profile). Set at topic
-- creation by the dispatcher from board_settings.dispatch_mcp (NULL = the
-- 'bridge-only' default; 'inherit' = per-board escape hatch for boards whose
-- tasks genuinely need the global fleet, e.g. qlik work).
ALTER TABLE topics ADD COLUMN mcp_policy TEXT;
ALTER TABLE board_settings ADD COLUMN dispatch_mcp TEXT;
