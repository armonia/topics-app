# Tasks: refactor-master-into-kanban

## 1. Provider fix — Master runs on the subscription

- [ ] 1.1 In `server/routes/topics.ts:1360`, change the Master topic default `provider` from `"claude-code-team"` to `"claude-code"` (caller-supplied `provider` still wins).
- [ ] 1.2 In `resolveProvider` (`server/routes/topics.ts:227`), coerce legacy `claude-code-team` → `claude-code` at read time so Master topics already in the DB run on the subscription without a migration.
- [ ] 1.3 Confirm `getProvider("claude-code")` resolves (registered in `server/providers/index.ts`); add a guard so the `/api/topics/master` route returns a clear 500 with a remediation message if the `claude-code` provider failed to init (CLI missing).
- [ ] 1.4 Manual check: open a global Master with no `ANTHROPIC_API_KEY` set; the lead streams a reply via the `claude` CLI.

## 2. `## Next` parser (pure module)

- [ ] 2.1 Extract `## Next` parsing into a pure module (`server/lib/master-next-parser.ts`) returning `{ verb: 'COMPLETA'|'APRI', sessionRef, reason }[]`. Reuse the verb/back-compat logic currently in `MasterBoardStrip` (`COMPLETA`/`ARCHIVIA` synonym, `APRI`).
- [ ] 2.2 `bun:test` for the parser: valid block, mixed/malformed rows skipped, unknown verbs ignored, empty/"tutto pulito" → `[]`.

## 3. `task_events` writer + proposal upsert (Master → kanban)

- [ ] 3.1 On a Master assistant message, run the parser server-side and for each row compute `claude_task_id` = stable hash of `(verb, sessionRef, normalized reason)`.
- [ ] 3.2 Resolve `project_id` per design AD-4: referenced topic's `project_path` → project id, else synthetic global board id (create on demand).
- [ ] 3.3 Upsert a `tasks` row (`assigned_topic_id` = referenced session/topic, `claude_task_id`, `text` = reason/action, status column per verb) using the existing `idx_tasks_claude_task_id` unique index for dedupe.
- [ ] 3.4 Insert a `task_events` row (`type='proposal'`, `payload` = raw row text, `topic_id` = referenced session).
- [ ] 3.5 Broadcast `task:created` / `task:updated` so clients sync.
- [ ] 3.6 `bun:test` for the `task_events`→card adapter (hash stability, dedupe, project resolution fallback).

## 4. KanbanBoard proposal cards

- [ ] 4.1 Render proposal cards in `KanbanBoard` (a "Proposte" column, per design open question default) styled distinctly from manual tasks.
- [ ] 4.2 Clicking a proposal card focuses the linked session pane (`assigned_topic_id`), reusing the existing jump/focus mechanism.
- [ ] 4.3 `COMPLETA` resolves the linked proposal card to `done` (reversible); `APRI` keeps it actionable with the concrete action text.
- [ ] 4.4 When a linked session is archived/closed, auto-resolve its proposal card (design open question default).

## 5. Remove the duplicate UI + dead branch

- [ ] 5.1 After §4 is green, remove `MasterBoardStrip` and its mount point in `ChatPanel`; the kanban is now the single board.
- [ ] 5.2 Drop `claude-code-team` from the Master creation path; stop setting `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in the Master flow (`server/routes/terminal.ts:606`). Leave the `claude-code-team` terminal type usable manually but not as the Master engine.
- [ ] 5.3 Verify no remaining references couple the Master to Agent Teams / Agent View.

## 6. Tests + verification

- [ ] 6.1 Playwright E2E: open global Master → it emits proposals → proposal cards appear in the kanban → clicking a card jumps to the session → `COMPLETA` resolves the card.
- [ ] 6.2 Verify `NOT TOUCHED` invariants: `KanbanBoard` core, `PanelGrid`, `open_browser_pane` MCP tool unchanged in behavior.
- [ ] 6.3 Record UAT video per project convention (`performance/spec.md` + E2E with video).

## NOT TOUCHED (guardrails)

- Persistent `KanbanBoard` base behavior (only additive: proposal cards).
- Spatial multi-pane grid (`client/src/components/Layout/PanelGrid.tsx`).
- `open_browser_pane` MCP tool (`server/mcp/topics-mcp-server.ts`).
