# Design: interactive-claude-primitive

## Context

`server/routes/terminal.ts` already spawns interactive `claude` PTYs (`createSession`, `sessionType='claude-code'`): no `--print`, uses `--session-id`/`--resume`, appends `TOPICS_AGENT_SYSTEM_PROMPT` via `--append-system-prompt` (line 637), bridges the Topics MCP server, and exposes `requestBuffer(sessionId)` (line 595) to read scrollback. This is the subscription-included path (human-driven PTY). This change makes it the primitive and rebuilds the Master on top of it.

## Goals

- Every default unit of model work is an interactive `claude` PTY → subscription, no per-token billing.
- The Master is one such PTY, system-prompted to orchestrate, feeding kanban cards by buffer scraping.
- No paid engine (SDK, OpenClaw, `--print`) on the default path.

## Non-Goals

- Structured chat UI on the subscription (impossible under current billing).
- Robot-driven autonomy on the subscription.

## Decisions

### AD-1 — Master is a system-prompted interactive PTY

Add a Master role to terminal creation: `POST /api/terminal/sessions` accepts `role: 'master'`. When set, `createSession` appends a second `--append-system-prompt` carrying the orchestrator contract (the `## Next` / COMPLETA·APRI output rules, ported from the old `defaultMasterPrompt` in `topics.ts`). `--append-system-prompt` is additive (line 635 comment), so the existing `TOPICS_AGENT_SYSTEM_PROMPT` is preserved. The session is still a plain interactive `claude` PTY → subscription.

Single global Master: enforce one active `role='master'` terminal at a time (resume/focus instead of duplicating), mirroring the old idempotency.

### AD-2 — Proposals come from the terminal buffer, not chat messages

On demand (human action: a "valuta" button, or when the user's turn in the Master terminal ends), the server calls `requestBuffer(masterSessionId)`, strips ANSI, and runs `parseNextActions()` over the tail. The parsed proposals flow through the **existing** `runMasterIngest()` → `tasks` + `task_events` + WS broadcast → KanbanBoard cards. No model call is made by the app; we only read what the human-driven session already printed → Enter Key Test holds.

`runMasterIngest` is reused as-is. Its `sessions` list (topics + claude-code terminals) and `resolveProjectId` stay the same. Only the `content` argument changes: from the lead's last assistant message to the scraped, ANSI-stripped buffer tail.

### AD-3 — ANSI strip + block extraction is a pure, tested module

Add `server/lib/terminal-scrape.ts`: `stripAnsi(raw): string` and `extractLatestNextBlock(raw): string` (find the last `## Next` region in the scrollback). Pure, `bun:test`-covered (ANSI sequences, wrapped lines, multiple `## Next` blocks → take the last). Feeds the existing `parseNextActions`.

### AD-4 — Trigger is human-driven, never a poll

No `setInterval` auto-ask (that's robot-driven → metered). Ingest fires only on explicit human action: a button in the Master pane ("Aggiorna proposte") and/or detecting the human submitted a prompt and the session went idle. Default: explicit button. This keeps the whole flow on the Enter Key Test.

### AD-5 — Retire paid engines from the default path

- `topics.ts` POST `/api/topics/master` chat path (the `--print` Master) is removed; Master creation routes to the terminal-Master (AD-1).
- Provider picker hides SDK / OpenClaw / `claude-code` (`--print`) for new sessions; interactive terminal is the default primitive.
- Structured chat components are retired or gated. Done last, behind the working terminal-Master, to avoid a regression window.

### AD-6 — Reuse over rebuild

`master-next-parser.ts`, `master-proposals.ts`, `master-ingest.ts`, and the KanbanBoard proposal cards from `refactor-master-into-kanban` are kept verbatim where possible. This change rewires their *input* (terminal buffer) and *trigger* (human button), not their logic.

## Architecture (flow)

```
Master = interactive `claude` PTY (--append-system-prompt: orchestrator contract)
  └─ human types "valuta le sessioni" + presses Enter        ← subscription (Enter Key Test)
       └─ claude prints reply incl. `## Next` block in the terminal
            └─ human clicks "Aggiorna proposte" (or session goes idle)
                 └─ server: requestBuffer() → stripAnsi() → extractLatestNextBlock()
                      └─ parseNextActions() → runMasterIngest()
                           └─ tasks + task_events + WS → KanbanBoard proposal cards
                                └─ click card → jump to session pane
```

No `--print`, no SDK, no robot Enter. Everything the model does is a direct response to a human keypress.

## Open Questions

- Trigger: explicit "Aggiorna proposte" button vs. idle-detection auto-scrape. Default: explicit button (safest on Enter Key Test; idle-scrape is still human-caused but fuzzier). 
- Do we keep the structured chat code dormant behind a flag, or delete it? Default: dormant first, delete after the terminal-primitive proves out.
