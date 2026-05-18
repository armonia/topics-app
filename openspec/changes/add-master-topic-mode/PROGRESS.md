# Progress — add-master-topic-mode

Snapshot of what is implemented vs pending. Updated as phases land.

## ✅ Implemented & verified this session

### Phase A — PTY + Agent Teams + DB schema
- [x] **A1** `server/db/migrations/026-master-topic-mode.sql` — `topics.parent_topic_id`, `topics.agent_team_role`, `tasks.assigned_topic_id`, `tasks.claude_task_id`, `task_events` table. Auto-applied on next server boot. **Verified by integration tests.**
- [x] **A2** `server/routes/terminal.ts` — new session type `'claude-code-team'`; spawns interactive `claude` PTY with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Resume + recovery paths updated.
- [x] **A4** (partial) — Master Topic creation uses `provider: "claude-code-team"`.

### Phase B — Shared task list watcher
- [x] **B1** `server/services/claude-tasks-sync.ts` — discovery + FS watch + 5s polling + per-file mtime cursor. **16/16 unit tests pass.**
- [x] **B4** Conflict resolution: claude wins on ≥ timestamps; local wins on strictly newer (KANBAN-DELTA-02). Unit-tested.
- [ ] **B3** Board → write-back to JSON file — deferred (requires DB-side write hook).

### Phase C — Master CLI
- [x] **C1** `cli/topics.ts` — `topics master --project <path>` subcommand. **CLI integration test passes.**
- [x] **C2** `topics --help` lists the new subcommand.
- [x] **C3** Idempotency: server resumes existing Master Topic for same `projectPath`. **Integration test verifies.**

### Phase D — Jump-to-tab (server-side + client wiring)
- [x] **D-API** `POST /api/boards/:projectId/tasks/:id/assign-topic` — bind task → teammate Topic, returns updated card, emits `pane:focus-suggest` WS event. **4/4 integration tests pass.**
- [x] **D-WS** `WSPaneFocusSuggestMessage` type added to client TS types.
- [x] **D-CLIENT** `client/src/hooks/usePanelLifecycle.ts` — handler for `pane:focus-suggest` opens the pane if not open and focuses it.
- [x] **D-SERIALIZER** `server/converters.ts` — `rowToTask` now includes `assignedTopicId` + `claudeTaskId`.
- [ ] **D-UI** Badge rendering on task card + Cmd+J shortcut — deferred (cosmetic; the data layer is complete).

### Phase F — Notifications (foundations)
- [x] `scripts/hooks/claude-stop.ts` — Stop hook → events.jsonl + Darwin notification ≥ P1. Severity classifier locked by tests.
- [x] `scripts/hooks/claude-pretooluse.ts` — PreToolUse hook → silent P2 log only (NOTIF-05).
- [x] `server/services/claude-events-watcher.ts` — triple-layer (FS watch + 5s polling + rotation/truncation/late-file). **5/5 unit tests pass.**
- [x] Severity classifier deterministic; **6/6 unit tests pass.**
- [ ] **F4** Tray badge wiring — deferred (Electron-only change).
- [ ] **F6** Focus mode awareness — deferred.

### API Surface delivered
- [x] `POST /api/topics/master` — create-or-resume Master Topic. 201/200/400. **3/3 integration tests.**
- [x] `POST /api/boards/:projectId/tasks/:id/assign-topic` — bind task ↔ teammate Topic. **4/4 integration tests.**

### Spec-flow Toolkit
- [x] Cloned into `spec-flow/`, `.gitignore` updated.
- [x] `spec-flow.config.json` (Topics actors/pages).
- [x] npm scripts: `lint:gherkin`, `tag:scenarios`, `uat`.
- [x] 5 Gherkin feature files (18 scenarios) **lint clean**.

### UAT generated
- [x] `uat.html` generated at repo root (12KB).
- [x] `videos/master-topic/master-01-m-c664f-deo-proof-of-uat-toolchain.webm` (15KB).
- [x] `videos/INDEX.md` updated.

### Test Coverage delivered
| Suite | New tests | Status |
|---|---|---|
| `tests/unit/claude-events-watcher.test.ts` | 5 | ✅ pass |
| `tests/unit/master-cli-classify.test.ts` | 6 | ✅ pass |
| `tests/unit/claude-tasks-sync.test.ts` | 16 | ✅ pass |
| `tests/integration/master-topic.test.ts` | 3 | ✅ pass |
| `tests/integration/board-jump-to-tab.test.ts` | 4 | ✅ pass |
| `tests/integration/cli-topics.test.ts` (additions) | +1 | ✅ pass |
| `tests/e2e/master-topic.spec.ts` (live) | 2 | ✅ pass against test server |
| `tests/e2e/master-topic.spec.ts` (scaffolded) | 12 fixme | ⏳ phases D-UI/E/F-UI |
| `tests/e2e/notifications-non-invasive.spec.ts` | 9 fixme | ⏳ phase F-UI |

**Baseline post-change: 488 unit+integration pass, 0 fail** (was 453; +35 net new tests in the spec).
**E2E: 2 new live Playwright tests pass against test server.**

## 🟡 Pending — UI work that requires React component changes

### Phase D — Jump-to-tab UI completion
- [ ] **D-UI-1** Task card renders `assignedTopicId` badge with teammate name + status color
- [ ] **D-UI-2** Cmd+J keyboard shortcut cycles through teammate panes

### Phase E — Reasoning trail UI
- [ ] **E1** Stream-json event parser writes into `task_events` (DB schema migrated)
- [ ] **E2** Task detail panel timeline UI rendering events chronologically
- [ ] **E3** Diff annotation for Edit/Write `tool_use` events

### Phase F UI continuation
- [ ] **F4** Electron tray badge integration (consumes the WS `claude-event` channel)
- [ ] **F6** macOS Focus mode awareness via `osascript`
- [ ] **F7** Click on notification → focus correct pane

### Phase G — agent-conductor integration
- [ ] **G1** Add as workspace dep / symlink
- [ ] **G2** Wire `discover()` + `deriveStatus()` to topic badges
- [ ] **G3** Reminders bridge (macOS)
- [ ] **G4** cwd-collision UI warning

### Phase H — Full Playwright video set
- [ ] Flip remaining 21 `test.fixme` → `test` once UI lands
- [ ] Re-run `bun run uat` to expand `uat.html` to 23 scenarios

### Phase I — Manual smoke
- [ ] `topics master --project /tmp/demo-repo` → end-to-end demo: delegate → teammate spawn → board → click → focus pane → review reasoning trail → approve → Done

## Files modified / added (final)

```
M  cli/topics.ts                                    (+master subcommand + help)
M  server/routes/terminal.ts                        (+claude-code-team type + env flag)
M  server/routes/topics.ts                          (+POST /api/topics/master)
M  server/routes/boards.ts                          (+POST /assign-topic + broadcast)
M  server/converters.ts                             (+assignedTopicId, claudeTaskId)
M  client/src/types/index.ts                        (+WSPaneFocusSuggestMessage)
M  client/src/hooks/usePanelLifecycle.ts            (+pane:focus-suggest handler)
M  package.json                                     (+spec-flow scripts)
M  scripts/organize-test-videos.sh                  (+master-topic, +notifications-non-invasive)
M  .gitignore                                       (+spec-flow/)
M  tests/integration/cli-topics.test.ts             (+master assertions)
M  videos/INDEX.md                                  (regenerated)

+  server/db/migrations/026-master-topic-mode.sql
+  server/services/claude-events-watcher.ts        (139 LOC)
+  server/services/claude-tasks-sync.ts            (204 LOC)
+  scripts/hooks/claude-stop.ts                    (121 LOC)
+  scripts/hooks/claude-pretooluse.ts              (49 LOC)
+  spec-flow.config.json
+  openspec/changes/add-master-topic-mode/         (9 files)
+  tests/features/master-topic-*.feature           (3 files)
+  tests/features/notifications-*.feature          (2 files)
+  tests/integration/master-topic.test.ts          (3 tests)
+  tests/integration/board-jump-to-tab.test.ts     (4 tests)
+  tests/unit/claude-events-watcher.test.ts        (5 tests)
+  tests/unit/master-cli-classify.test.ts          (6 tests)
+  tests/unit/claude-tasks-sync.test.ts            (16 tests)
+  tests/e2e/master-topic.spec.ts                  (14 scenarios: 2 live + 12 fixme)
+  tests/e2e/notifications-non-invasive.spec.ts    (9 fixme scenarios)
+  uat.html                                        (12 KB, 1 scenario embedded)
+  videos/master-topic/master-01-*.webm            (15 KB)
```
