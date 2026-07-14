-- Backfill `standalone` for historical catch-all topics.
--
-- Migration 044 added topics.standalone but defaulted every existing row to 0,
-- so catch-all agent sessions created before the flag was persisted still seed
-- a phantom "generale" project node in the sidebar (buildSidebarItems groups by
-- projectPath unless standalone). The dispatcher now sets standalone=1 for new
-- catch-all sessions (task-dispatcher.ts), but the ~7 legacy ones — chats rooted
-- at the shared `workspace/generale` dir or an early `workspace/tasks/<id8>` cwd
-- — need a one-time backfill so "task senza progetto" render ungrouped at the
-- top level instead of under a fake board. Anchored to the OpenClaw workspace
-- layout so no real user project is touched.
UPDATE topics
   SET standalone = 1
 WHERE standalone = 0
   AND ( project_path LIKE '%/.openclaw/workspace/generale'
      OR project_path LIKE '%/.openclaw/workspace/tasks/%' );
