-- Un-phantom the "topics-app" husk chats.
--
-- A handful of archived catch-all/test topics were rooted at
-- `~/.openclaw/workspace/topics-app` — a husk workspace dir that duplicates the
-- name of the real repo project (~/Projects/topics-app), from the old
-- stale-June-binding bug. buildSidebarItems seeds a project node from ANY
-- non-standalone topic projectPath, so these seed a SECOND "topics-app" node in
-- the sidebar. Migration 045 only covered the generale/tasks catch-alls; flag
-- these too so they render ungrouped and the phantom duplicate disappears. The
-- husk dir itself is trashed; the display filter (isSelectableProjectDir) keeps
-- any recreated marker-less husk out of the picker.
UPDATE topics
   SET standalone = 1
 WHERE standalone = 0
   AND project_path LIKE '%/.openclaw/workspace/topics-app';
