-- 073-topic-muted.sql: persist a per-topic notification mute.
--
-- Completion notifications were all-or-nothing (the global
-- notificationsEnabled toggle). With ten topics running and agents finishing
-- in bursts, the only defense was killing every banner — losing the one that
-- mattered too. This column lets a single topic be silenced without touching
-- the rest: when 1, useCompletionNotifier suppresses that topic's completion
-- banner + sound, but the completion STILL counts toward the app badge
-- (navigator.setAppBadge) so nothing is lost — it just doesn't interrupt.
--
-- NULL/0 = not muted (backward compatible for every existing topic). The value
-- takes effect on the next completion; the chat/topics PATCH broadcasts
-- `topic:updated` so every open window applies it immediately. A PROJECT-wide
-- mute lives separately in AppSettings.mutedProjects (keyed by projectPath),
-- since a project is identified by path string with no guaranteed row here.

ALTER TABLE topics ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (73, '073-topic-muted', datetime('now'));
