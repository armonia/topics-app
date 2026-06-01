# Change: interactive-claude-primitive

## Why

Anthropic's 2026 billing changes make the app's chat engines unusable on a Claude subscription:

- **2026-04-04**: Claude subscriptions stopped working with third-party tools (Cline, Cursor, Windsurf, any non-Anthropic harness). Only Anthropic's own first-party tools (the `claude` CLI, the official VS Code extension) authenticate against the subscription. Topics App is a third-party harness.
- **2026-06-15**: programmatic surfaces — the Claude Agent SDK, `claude --print` (headless), GitHub Actions, and third-party apps — move OFF the subscription onto a separate metered credit billed at full API rates (no rollover).

The decisive rule Anthropic states is the **"Enter Key Test"**: if a human presses Enter, the work stays on the subscription; if a robot presses Enter, it draws from the metered credit.

Every structured-chat path in this app fails that test for free subscription use:
- The SDK provider (`server/providers/claude.ts`) needs `ANTHROPIC_API_KEY` → pays per token.
- The `claude-code` provider (`server/providers/claude-code.ts`) spawns `claude --print --output-format stream-json` → headless → metered credit / API rates after 2026-06-15.
- The OpenClaw gateway → separate credit.

The earlier change `refactor-master-into-kanban` pointed the Master at the `claude-code` (`--print`) provider believing it was subscription-backed. The billing change invalidates that premise, so this change supersedes it.

**The one path that stays on the subscription** is hosting the real **interactive `claude` CLI in a PTY**, where the human types and presses Enter. That is not "third-party programmatic use" — it is a terminal emulator around Anthropic's own binary, driven by a human. The app already does exactly this for terminal sessions (`server/routes/terminal.ts`, `createSession` with `sessionType='claude-code'`, no `--print`).

## What changes

1. **Interactive `claude` PTY becomes the primitive.** A topic/session's unit of work is an interactive `claude` terminal (subscription-included), not a structured chat backed by a paid provider.
2. **Master = a terminal with a system prompt.** Instead of a paid chat, the Master is an interactive `claude` PTY launched with `--append-system-prompt` carrying the orchestrator contract (the `## Next` / COMPLETA·APRI rules). The human prompts it and presses Enter → subscription.
3. **Proposals → kanban cards by scraping the terminal buffer.** We read the Master terminal's scrollback (`requestBuffer`, `terminal.ts:595`), run the existing `## Next` parser over the visible text, and upsert kanban cards. Reading on-screen text is not a model call — it stays on the subscription. Reuses `master-next-parser.ts`, `master-proposals.ts`, `master-ingest.ts`, and the KanbanBoard proposal cards already built.
4. **Remove the paid chat engines.** The SDK provider, the OpenClaw gateway, and the `claude-code` (`--print`) provider stop being selectable/default for sessions. The structured chat UI that depends on the provider→messages stream is retired (or left dormant) since it cannot run free on the subscription.
5. **No auto-pilot autonomy by default.** Any robot-driven loop (the old MasterBoardStrip auto-ask, auto-send) fails the Enter Key Test and is removed from the default path. Autonomy, if ever offered, is an explicit opt-in labeled as consuming the metered Agent SDK credit.

## What is reused from refactor-master-into-kanban

- `server/lib/master-next-parser.ts` — parses `## Next` from any text source (now the terminal buffer instead of a chat message).
- `server/lib/master-proposals.ts` + `server/lib/master-ingest.ts` — proposal→card upsert + `task_events`, unchanged except the input source.
- KanbanBoard proposal cards (`TaskCard` rendering, jump-to-session).

## What is dropped from refactor-master-into-kanban

- The `claude-code` provider default for the Master (it was the `--print` paid path).
- The chat-message-based ingest trigger (replaced by terminal-buffer scraping).

## Out of scope

- Rebuilding structured chat (bubbles, checkpoints, cost tracking) on a subscription-free basis — not possible under current billing.
- Auto-pilot / always-on autonomous orchestration on the subscription (it's robot-driven → metered).

## Risks

- **Buffer scraping fragility**: terminal scrollback is rendered text (ANSI, wrapping). Extracting a clean `## Next` block needs ANSI stripping and tolerance to wrapping. Mitigation: the parser already degrades gracefully; add an ANSI-strip pre-pass with unit tests.
- **Losing structured chat UX**: bubbles/history/checkpoints/context-pills go away for the primitive. Accepted trade-off — it's the price of staying on the subscription.
- **ToS**: hosting the interactive CLI in a third-party PTY where a human drives it is the closest-to-sanctioned path (it's Anthropic's binary, human-driven), but it remains the user's call.

## Impact

- **Code**: `server/routes/terminal.ts` (Master-role terminal + buffer ingest trigger), `server/routes/topics.ts` (remove the `--print` Master chat path), `server/providers/*` (deselect paid engines), `client/src/components/Chat/*` + `Board/MasterBoardStrip.tsx` (retire structured chat + auto-ask), `client/src/components/Board/*` (keep proposal cards).
- **DB**: reuses migration 026 (`tasks.claude_task_id`, `assigned_topic_id`, `task_events`). No new migration.
- **Tests**: `bun:test` for the ANSI-strip + buffer→`## Next` extraction; Playwright E2E for the terminal-Master → cards flow (requires a running server + authenticated `claude` CLI).
