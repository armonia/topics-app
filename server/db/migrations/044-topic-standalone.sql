-- Presentation-only flag: a topic that keeps its `project_path` (the agent's
-- cwd) but must NOT surface as a project in the sidebar/layout — a dispatcher
-- agent session on a per-task catch-all workspace. 1 = standalone (its own
-- splittable task workspace / loose tab), 0 = normal (project chats grouped
-- under their project window). See server/lib/session-control-core.ts and the
-- client's isTaskWorkspacePath / buildSidebarItems standalone handling.
ALTER TABLE topics ADD COLUMN standalone INTEGER NOT NULL DEFAULT 0;
