# Tasks: interactive-claude-primitive

## 1. Stop the billing bleed (do first — safe, no teardown)

- [ ] 1.1 Make the interactive `claude` PTY terminal the default primitive for new sessions; demote/hide the SDK, OpenClaw, and `claude-code` (`--print`) engines from the default selection (keep code, not selectable by default).
- [ ] 1.2 Ensure no path auto-sends to a paid provider (remove the MasterBoardStrip auto-ask loop / any `setInterval` that prompts the model).
- [ ] 1.3 Verify (live, once server restarted): a new session opens an interactive `claude` PTY and `/status` inside it shows the subscription plan.

## 2. Master = system-prompted interactive PTY (AD-1)

- [ ] 2.1 Add a master orchestrator system prompt module (port `defaultMasterPrompt` from `topics.ts` — the `## Next` / COMPLETA·APRI contract).
- [ ] 2.2 `POST /api/terminal/sessions` accepts `role: 'master'`; `createSession` appends a second `--append-system-prompt` with the orchestrator prompt (additive to `TOPICS_AGENT_SYSTEM_PROMPT`).
- [ ] 2.3 Enforce a single active `role='master'` terminal (resume/focus instead of duplicate).
- [ ] 2.4 Route the existing "Open Master" UI affordance to create/focus the terminal-Master instead of the chat-Master.

## 3. Terminal buffer scrape → `## Next` (AD-2, AD-3)

- [ ] 3.1 `server/lib/terminal-scrape.ts`: `stripAnsi(raw)` + `extractLatestNextBlock(raw)` (last `## Next` region). Pure.
- [ ] 3.2 `bun:test` for terminal-scrape: ANSI sequences stripped, wrapped lines joined, multiple `## Next` → last one, no block → empty.
- [ ] 3.3 Ingest path: `requestBuffer(masterSessionId)` → `stripAnsi` → `extractLatestNextBlock` → `parseNextActions` → `runMasterIngest` (reused). Wire the session list + `resolveProjectId` as today.

## 4. Human-driven trigger (AD-4)

- [ ] 4.1 "Aggiorna proposte" action in the Master pane → calls the buffer-scrape ingest. No polling/auto-ask.
- [ ] 4.2 (Optional) idle-detection: when the Master PTY goes idle after a human prompt, offer (not auto-run) the scrape.

## 5. Retire paid chat (AD-5) — last, behind a working terminal-Master

- [ ] 5.1 Remove the `--print` Master chat path in `topics.ts` (POST `/api/topics/master`).
- [ ] 5.2 Remove `MasterBoardStrip` (its triage now lives in the kanban cards; its auto-ask is gone per 1.2).
- [ ] 5.3 Gate or remove the structured chat UI (`client/src/components/Chat/*` provider-stream path) + dead providers. Dormant-first, delete after proof-out.

## 6. Tests + verification (needs running server + authenticated claude CLI)

- [ ] 6.1 Playwright E2E: open terminal-Master → human prompt → claude prints `## Next` → "Aggiorna proposte" → cards appear in kanban → click jumps to session.
- [ ] 6.2 Confirm `/status` in primitive terminals shows subscription (no API billing) — manual + documented.
- [ ] 6.3 NOT TOUCHED invariants: KanbanBoard core, PanelGrid, open_browser_pane MCP tool.

## Reused verbatim from refactor-master-into-kanban

- `server/lib/master-next-parser.ts`, `master-proposals.ts`, `master-ingest.ts` (+ their bun:tests).
- KanbanBoard proposal cards in `TaskCard` (purple accent, Sparkles, jump-to-session).

## NOT TOUCHED (guardrails)

- Persistent `KanbanBoard` base behavior.
- Spatial multi-pane grid (`PanelGrid`).
- `open_browser_pane` MCP tool.
- The interactive PTY billing posture (must stay human-driven — never auto-send to the model).
