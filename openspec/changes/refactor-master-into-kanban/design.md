# Design: refactor-master-into-kanban

## Context

The Master ("lead" topic, `agent_team_role='lead'`) already builds a per-turn snapshot of all active sessions from the app's own DB (`topics`, `messages`, `unread`, `terminal_sessions`) and instructs the model to emit a `## Next` block with `COMPLETA`/`APRI` rows (`server/routes/topics.ts:1142-1378`). `MasterBoardStrip` parses the lead's last assistant message and renders those rows as buttons (`client/src/components/Board/MasterBoardStrip.tsx`). The persistent kanban (`KanbanBoard`, `tasks` table) is a separate, fully working feature.

This change rewires the Master to (a) run on the subscription and (b) emit into the persistent kanban instead of a separate strip. It does **not** introduce a new orchestration engine.

## Goals

- Master chat usable on a Claude Pro/Max subscription (no `ANTHROPIC_API_KEY`).
- Exactly one global Master brain; suggestions surfaced contextually per section.
- Master proposals become persistent kanban cards, linked to their session.
- Remove the duplicate triage UI and the experimental PTY-teams branch.

## Non-Goals

- Real multi-agent execution (sub-agents writing code). Out of scope.
- Depending on Anthropic's native Agent View on-disk format.

## Decisions

### AD-1 — Master runs on the `claude-code` chat provider

`server/routes/topics.ts:1360` defaults the Master topic to `provider: "claude-code-team"`, which is not a registered chat provider (`server/providers/index.ts` registers only `claude-code`). `getProvider` throws for unknown names, but `resolveProvider` (`server/routes/topics.ts:227-232`) catches the throw and falls back to `getDefaultProvider()` — so today the Master silently runs on a non-deterministic default. Change the default to `claude-code`. The `claude-code` provider (`server/providers/claude-code.ts`) spawns the `claude` CLI with stream-json → subscription auth, no SDK, no API key. A caller-supplied `provider` still wins.

**Legacy rows:** existing Master topics already persisted with `provider="claude-code-team"` must keep working. `resolveProvider` coerces `claude-code-team` → `claude-code` at read time, so old leads run on the subscription without a data migration.

### AD-2 — One global Master, contextual surfaces

Keep the existing idempotency (one global lead when `projectPath` is omitted; `server/routes/topics.ts:1260-1280`). Do **not** spawn a Master per project/section — that multiplies `claude` processes and burns quota. The single lead reads the cross-project snapshot it already builds; per-section context is a presentation concern (filtering proposal cards by the referenced session's project), not a second brain.

### AD-3 — Proposals become kanban cards via `task_events`

Migration 026 already added `task_events(claude_task_id, topic_id, ts, type, payload)` and `tasks.assigned_topic_id` / `tasks.claude_task_id`, but nothing writes them. Wire them as the Master→kanban link:

- When the Master emits a `## Next` block, a server-side parser turns each row into a proposal record. `claude_task_id` = a stable hash of `(verb, session id, normalized reason)` so re-emitting the same proposal updates rather than duplicates (the unique index `idx_tasks_claude_task_id` enforces this).
- Each proposal upserts a `tasks` row with `assigned_topic_id` = referenced session/topic id, plus a `task_events` row (`type` = `proposal`, `payload` = the raw row text) for the trail.
- `APRI` → card in the actionable column with the concrete next action as the task text. `COMPLETA` → marks the linked session's existing proposal card `done` (reversible).

### AD-4 — `tasks.project_id` for cross-project proposals

`tasks.project_id` is `NOT NULL`. A proposal card inherits the referenced session's project: if the topic has a `project_path`, resolve it to the matching project id; if the session has no project (e.g. a standalone `claude-code` terminal), use a synthetic global board id (constant, created on demand) so the global Master has a home board. The `AllBoardsPane` cross-project view already aggregates boards, so global proposals surface there.

### AD-5 — Parser lives in a pure module

Extract `## Next` parsing into a pure, unit-tested module (e.g. `server/lib/master-next-parser.ts` or reuse the existing client parser logic in `MasterBoardStrip`). Parsing must degrade gracefully (unknown verbs ignored, malformed rows skipped) — no crash on format drift. This module is `bun:test`-covered per project rules.

### AD-6 — Remove the dead branch last, behind tests

Move (don't delete) the `## Next` parsing out of `MasterBoardStrip`, land the card pipeline with tests green, then delete `MasterBoardStrip` and its mount point. Separately, drop `claude-code-team` from the Master creation path (`server/routes/topics.ts`) and stop setting `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in the Master flow (`server/routes/terminal.ts:606`). The `claude-code-team` terminal type may remain available for manual use but is no longer the Master's engine.

## Architecture (flow)

```
Master lead (claude-code provider, subscription)
  └─ emits assistant message with `## Next` block
       └─ server parser → proposal records (hash → claude_task_id)
            └─ upsert tasks row (assigned_topic_id, project_id resolved per AD-4)
            └─ insert task_events row (type=proposal)
                 └─ WS task:created / task:updated
                      └─ KanbanBoard renders proposal card → click jumps to session pane
```

## Open Questions

- Should proposal cards live in a dedicated kanban column ("Proposte") or be tagged within existing columns? Default: a "Proposte" column, COMPLETA moves to done.
- Card lifecycle when the underlying session is archived/closed — auto-resolve the linked proposal? Default: yes, mark done.
