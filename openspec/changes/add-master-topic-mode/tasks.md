# Tasks: add-master-topic-mode

## Phase A — PTY + Agent Teams + DB schema

- [ ] A1. DB migration: add `topics.parent_topic_id`, `topics.agent_team_role`, `topics.claude_session_id`, `tasks.assigned_topic_id`, `tasks.claude_task_id`
- [ ] A2. `server/routes/terminal.ts`: support `type: 'claude-code-team'` variant — same as `claude-code` but adds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to env
- [ ] A3. Smoke test: spawn `claude` with flag, verify `--help` exits 0 and includes team-related entries
- [ ] A4. Audit `server/providers/claude-code.ts` (the `--print` provider) — label it as "programmatic" in UI, ensure default is the PTY path

## Phase B — Shared task list watcher

- [ ] B1. New `server/services/claude-tasks-sync.ts` with chokidar watcher on `~/.claude/projects/<hash>/tasks/*.json`
- [ ] B2. On file change → upsert into Topics `tasks` table, set `claude_task_id`
- [ ] B3. Bidirectional: when a task is edited in board, write back JSON
- [ ] B4. Conflict resolution: last-write-wins with timestamp; warn user on collision
- [ ] B5. Test: simulate Claude writing a task → verify board renders within 2s

## Phase C — Master CLI

- [ ] C1. `cli/topics.ts`: subcommand `master --project <path>` that:
  - Creates Master Topic in DB with `agent_team_role='lead'`
  - Calls existing daemon API to spawn terminal session with team flag
  - Opens `localhost:3333/master/<id>` in default browser
- [ ] C2. Help text + examples in `topics --help`
- [ ] C3. Idempotency: re-running `topics master` on same path resumes existing Master Topic

## Phase D — Jump-to-tab

- [ ] D1. Kanban task card: click → emit `pane:focus` event with `assigned_topic_id`
- [ ] D2. Layout manager: handle event → find pane hosting topic → focus + scroll into view
- [ ] D3. Keyboard shortcut: `Cmd+J` from board cycles through teammate panes

## Phase E — Reasoning trail

- [ ] E1. Server-side stream-json event parser: intercept teammate session events, store in `events` table per `claude_task_id`
- [ ] E2. Event types stored: `thinking`, `tool_use`, `tool_result`, `task_complete`, `task_failed`
- [ ] E3. Task detail panel: timeline UI rendering events chronologically with collapsible thinking blocks
- [ ] E4. Diff annotation: for `tool_use` of type `Edit`/`Write`, show inline diff next to event

## Phase F — Notifications (triple-layer, non-invasive)

- [ ] F1. Claude Code hook config: `~/.claude/settings.json` adds Topics hook scripts for `Stop`/`PreToolUse` that write to `~/.topics/events.jsonl`
- [ ] F2. File watcher in Topics on events.jsonl
- [ ] F3. Polling fallback every 5s
- [ ] F4. Electron tray badge updates on awaiting-review count
- [ ] F5. Severity routing: P0 → sound + push, P1 → silent desktop notif, P2 → badge only
- [ ] F6. Focus mode awareness: read macOS Focus state via `osascript`, suppress non-P0
- [ ] F7. Click on notification → focus correct pane

## Phase G — agent-conductor integration

- [ ] G1. Add `agent-conductor` as workspace dependency
- [ ] G2. Wire `discover()` + `deriveStatus()` to enrich Topics agent badge
- [ ] G3. Reminders bridge: subscribe to `todo:added`/`todo:completed`/`todo:updated` events → optionally create kanban tasks
- [ ] G4. Conflict lock (cwd collision) surfaced as UI warning when 2 topics target same project

## Phase H — Tests + spec-flow UAT

- [ ] H1. Run `npm test` baseline — capture pre-change test count
- [ ] H2. Write Playwright features under `tests/features/master-topic/*.feature`
- [ ] H3. `bun run lint:gherkin` passes
- [ ] H4. `bun run tag:scenarios` adds tags
- [ ] H5. Playwright run produces videos
- [ ] H6. `bun run uat` generates `uat.html`
- [ ] H7. Update `videos/INDEX.md`
- [ ] H8. All existing tests still pass
- [ ] H9. New scenarios: ≥12 passing, ≥3 per spec area

## Phase I — Verification & sign-off

- [ ] I1. End-to-end smoke: `topics master --project /tmp/demo-repo` → user delegates "create README" → teammate spawned → task on board → click → jump to tab → review reasoning trail → approve → task moves to Done
- [ ] I2. Notification flow: simulate awaiting-review → desktop notif appears → click → correct pane focused
- [ ] I3. Token budget warning fires when 4th teammate spawned on Pro tier
- [ ] I4. Documentation: README section + screenshots/gifs
- [ ] I5. CHANGELOG entry
