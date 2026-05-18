# Change: add-master-topic-mode

## Why

Topics today is a multi-topic workspace where each topic is an independent Claude session. To work on multi-project workloads the user must manually open one Topic per project and orchestrate them by hand.

Anthropic shipped **Claude Code Agent Teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) — a built-in Mayor pattern where one "lead" session delegates work to teammates via a shared task list. Each teammate runs in its own context window. This is **sub-safe** (first-party Anthropic, interactive PTY, no pool credit) and **multi-project** when teammates are spawned with different `cwd`.

Topics is well-positioned to wrap Agent Teams into a workspace UI: master chat + kanban board + per-teammate topic panes + jump-to-tab from a task card.

## What changes

1. **Master Topic mode** — a topic whose `claude` PTY is spawned with the Agent Teams flag, designated as `agent_team_role='lead'`.
2. **Teammate Topics** — auto-spawned by master, linked via `parent_topic_id`. Each runs in a project-specific `cwd`.
3. **Shared task list sync** — Topics file-watches `~/.claude/projects/<hash>/tasks/` and mirrors tasks into the existing kanban board.
4. **Task ↔ Topic binding** — kanban tasks carry an `assigned_topic_id`; clicking a card focuses the corresponding teammate pane.
5. **Master CLI** — new subcommand `topics master --project <path>` that creates a Master Topic and opens it in the browser.
6. **Reasoning trail** — for each task, a timeline UI showing the teammate's stream-json events (thinking, tool use, results).
7. **Notifications (non-invasive)** — triple-layer (Darwin notif + FS watch + 5s polling), severity-routed, action-only (no notifications for routine activity).
8. **agent-conductor integration** — imported as a dependency to leverage its side-car observer pattern + Reminders bridge.

## Out of scope (future phases)

- Refinery merge queue (Bors-style auto-merge)
- Inline diff WYSIWYG accept/reject editor
- Git worktree first-class one-click
- Visual editors (Excalidraw, Mermaid, ERD)
- AI-assisted commit messages

## Risks

- **Agent Teams is experimental** — flag may change between Claude Code releases; needs CI smoke test against current CLI version.
- **Token consumption** — Mayor + N teammates burns weekly limit faster than single-session. Mitigation: UI warning when active teammate count > 3 on Pro tier.
- **Anthropic policy** — Topics could theoretically be named in the third-party agent list (pool credit) if it gains visibility. Current scope: personal/small-team use under the radar.
- **Stream-json parsing fragility** — Claude Code changes its event shape periodically; parser must degrade gracefully.

## Impact

- **Specs added**: `master-topic/`, `notifications/`, `agent-conductor-integration/`
- **Specs modified (delta)**: `kanban/`, `terminal/`
- **Code areas**: `server/routes/terminal.ts`, `server/services/claude-tasks-sync.ts` (new), `server/providers/`, `cli/topics.ts`, `client/src/components/board/`, `client/src/components/topic/`
- **DB migration**: additions to `topics` and `tasks` tables (non-breaking, all nullable)
- **Tests**: new Playwright features under `tests/features/master-topic/`, `tests/features/notifications/`

## Estimate

~18–22 dev-days for Tier-1 MVP. Phasing:
- **Phase A**: PTY + Agent Teams flag + DB schema (3d)
- **Phase B**: Shared task list watcher + kanban binding (3d)
- **Phase C**: Master CLI + browser flow (1d)
- **Phase D**: Jump-to-tab + UI polish (2d)
- **Phase E**: Reasoning trail timeline (4d)
- **Phase F**: Notifications triple-layer (3d)
- **Phase G**: agent-conductor integration + Reminders bridge (2d)
- **Phase H**: Tests + spec-flow UAT + video (2-3d)
