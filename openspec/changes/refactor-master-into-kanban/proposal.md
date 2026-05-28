# Change: refactor-master-into-kanban

## Why

The `add-master-topic-mode` change built the Master as a "lead" topic that orchestrates teammates via Claude Code Agent Teams (experimental PTY) plus a separate triage strip (`MasterBoardStrip`). Two things make that design unworkable today:

1. **Subscription auth.** Recent Anthropic changes mean a Claude Pro/Max subscription authenticates only through the `claude` CLI, not the Anthropic SDK (which needs a paid `ANTHROPIC_API_KEY`). The Master topic is created with `provider: "claude-code-team"` (`server/routes/topics.ts:1360`), but `claude-code-team` is **not** a registered chat provider — only `claude-code` is (`server/providers/index.ts`). `getProvider("claude-code-team")` throws, and `resolveProvider` (`server/routes/topics.ts:227-232`) swallows the throw and **silently falls back to the default provider** — so the Master runs on whatever the default happens to be, not the intended subscription CLI, and on a machine with no usable default it produces no/garbled output. The only chat engine guaranteed to run on the subscription is the `claude-code` provider (`server/providers/claude-code.ts`), which spawns the `claude` CLI with stream-json instead of calling the SDK.

2. **Native overlap + duplicate UI.** Anthropic shipped Agent View (May 2026) and a redesigned desktop app that already cover native multi-session supervision — rebuilding that brain is redundant. Meanwhile the app carries two boards that don't talk to each other: `MasterBoardStrip` (ephemeral triage strip) and the persistent `KanbanBoard` (the `tasks` table).

The Master's durable value is not "another orchestration brain" — it is a single chat, on the subscription, that surfaces what each session needs as cards in the kanban the user already watches, inside the spatial pane grid.

## What changes

1. **Provider fix** — the Master lead runs on the `claude-code` chat provider (subscription via CLI), not `claude-code-team`. The default provider for a Master topic becomes `claude-code` (`server/routes/topics.ts:1360`).
2. **Single global brain** — one global Master (no `projectPath`) surfaces contextual suggestions per project/section. No per-section Master chats: that would multiply `claude` processes and burn the subscription quota. One mind, many surfaces.
3. **Board fusion** — the standalone `MasterBoardStrip` is removed as a separate UI. The Master's `## Next` proposals (verbs `COMPLETA`/`APRI`) become "proposal" cards in the persistent `KanbanBoard` (`tasks` table), linked to the originating session via `task_events` (created in migration 026, never written until now).
4. **Dead-branch removal** — drop the experimental PTY Agent Teams path (`claude-code-team` sessionType + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) from the Master flow, and take **no** dependency on Anthropic's native Agent View (research-preview, unstable `~/.claude/jobs/` format). The Master stays model A (chat-delega) reading the app's own DB.

## Out of scope

- Real Claude Code Agent Teams / sub-agent execution (the removed PTY path).
- Reading or mirroring Anthropic's native Agent View session state.
- agent-conductor integration, Reminders bridge, reasoning-trail timeline (deferred from `add-master-topic-mode`).
- The persistent `KanbanBoard` core, the spatial pane grid (`PanelGrid`), and the `open_browser_pane` MCP tool — explicitly NOT touched.

## Risks

- **`tasks.project_id` is NOT NULL** — a global Master's proposals span projects, but every task row needs a `project_id`. Mitigation: a proposal card inherits the referenced session's project; sessions with no project map to a synthetic "global" board id. See design.
- **Removing `MasterBoardStrip`** may regress existing Master UX during transition. Mitigation: keep the `## Next` parsing logic (move it, don't delete it), migrate proposals to cards behind tests before deleting the strip.
- **`## Next` parsing fragility** — proposal extraction must degrade gracefully if the model's output format drifts.

## Impact

- **Specs modified (delta)**: `master-topic/` (provider, single global brain; REMOVE PTY teammate spawn + Agent Teams flag), `kanban/` (proposal cards + `task_events` link + jump-to-session).
- **Code areas**: `server/routes/topics.ts` (provider default, `/api/topics/master`), `server/providers/index.ts` (provider naming), `server/routes/terminal.ts` (drop `claude-code-team` from the Master flow), `client/src/components/Board/` (KanbanBoard proposal cards; remove `MasterBoardStrip`), new `task_events` writer + `## Next`→card adapter.
- **DB**: uses existing migration 026 columns (`assigned_topic_id`, `claude_task_id`, `task_events`) — **no new migration required**.
- **Tests**: Playwright E2E for the proposal→card flow; `bun:test` for the `## Next` parser and the `task_events`→card adapter.

## Estimate

~4–6 dev-days:
- Provider fix + Master runs on subscription (0.5d)
- `task_events` writer + `## Next`→card adapter (1.5d)
- KanbanBoard proposal cards + remove `MasterBoardStrip` (1.5d)
- Dead-branch removal (0.5d)
- E2E + unit tests (1–2d)
