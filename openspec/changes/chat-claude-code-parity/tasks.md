# Tasks: chat-claude-code-parity

Each task lists its verification. The change is complete only when every box is checked and the E2E suite passes. Work on a branch off `main` (a worktree per the board protocol).

## 0. Empirical capture (blocks everything — real wire shapes)

- [ ] 0.1 Build a headless capture harness: run the installed `claude` (v2.1.216) with `--input-format stream-json --output-format stream-json` and record raw frames. **Verify:** fixtures saved under `server/providers/claude/__fixtures__/`.
- [ ] 0.2 Capture a real `system`/`compact_boundary` frame (force via a large scripted context or `/compact` if honoured). **Verify:** fixture exists; note the exact `subtype` + metadata field names.
- [ ] 0.3 Capture the permission `control_request` frame with a prompting permission mode, and confirm which `--permission-mode` value emits it (`default` vs `manual`). **Verify:** fixture + documented mode string in `design.md §9`.
- [ ] 0.4 Determine empirically whether `/compact` sent as a stream-json `user` message triggers compaction. **Verify:** result recorded in `design.md §2` (`/compact` row resolved to supported/unsupported).

## S. Turn-finalization solidity (lands FIRST — fixes live "message disappears")

- [x] S.1 Field-isolated persistence: route `updateToolCallResult` / `updateBlockTool` through column-scoped SQL (`tool_calls`/`blocks` only), never rewriting `content`/`thinking`. **Verify:** `server/utils.ts:1018` (`updateToolCallResult`) e `:1050` (`updateToolCallFields`) scrivono la sola colonna `tool_calls` — commento «Owns tool_calls only» su entrambe; `server/utils-message-persistence.test.ts` verde.
- [ ] S.2 `finalized` latch on the message row: once a turn is finalized, later writes cannot re-touch `content`/`thinking`. **Verify:** unit test — a late `tool_result` after finalize does not zero content.
- [x] S.3 Non-destructive finalize on timeout/error/abort — **risolta in forma diversa da quella scritta qui, e la forma vecchia era peggiore.** Il finalize è non distruttivo per costruzione (`finalizeLastMessage`, `server/utils.ts`: passa `null` su `content`/`thinking`/`tool_calls` e lascia che `COALESCE` conservi ciò che è arrivato in streaming — «finalizing a turn must never blank its content»). Il marker letterale `[interrotto/timeout]` NON è stato aggiunto: un turno che ha prodotto qualcosa lo tiene com'è, e un turno che non ha prodotto NIENTE non lascia una bolla vuota da etichettare — viene scartato (`discardIfEmptyTurn` + predicato condiviso `shared/empty-turn.ts`, usato sia dal server prima di cancellare sia dal client prima di togliere la bolla locale). **Verify:** `shared/empty-turn.test.ts` + call site `server/routes/chat.ts:1226` e `server/routes/topics.ts:2199` (solo su `reason === "aborted"`).
- [x] S.4 Unify the two 30-min timeouts into one authoritative duration cap that resets on tool progress; keep a silent-turn ceiling but finalize non-destructively (no process-kill that discards output). **Verify:** `server/providers/claude-code.ts:1151-1172` — il watchdog è un backstop di INATTIVITÀ che si ri-arma su `pp.lastEventAt`, non un tetto a orologio: un turno che continua a emettere eventi non viene mai ucciso, uno muto per 30 min sì. (Il secondo `MESSAGE_TIMEOUT_MS` rimasto, `:1359`, è di `complete()` — percorso one-shot non-streaming, fuori dal turno.)
- [x] S.5a Client: `MessageList` non filtra via le righe a `content===''` che portano blocchi (`MessageList.tsx:164`, `Array.isArray(msg.blocks) && msg.blocks.length > 0`).
- [ ] S.5b Client: chip "interrotto" sulla riga di un turno troncato. **Verify:** E2E — un turno andato in timeout mostra la sua timeline di tool con il chip, non sparisce.
- [x] S.6 Le righe vuote storiche: **una migrazione È servita**, al contrario di quanto scritto qui in origine. Non erano 36 ma 170, e restavano anche nella history rimandata al modello a ogni turno successivo — non era un problema di sola visualizzazione. **Verify:** `server/db/migrations/071-drop-empty-assistant-turns.sql` (commit `4836a39a`), applicata al DB di produzione.

## 1. Compaction — surface, persist, render, honest silence

- [x] 1.1 `server/providers/claude/compaction.ts`: pure `parseCompactBoundary(event)` → `CompactionMarker | null`, defensive on missing fields. **Verify:** `bun:test` against 0.2 fixture + malformed inputs.
- [x] 1.2 `claude-code.ts:1640`: branch `compact_boundary` before the `system` drop → `handleCompactBoundary` → `onCompaction` hook (`types.ts`) + StaleStream bump. **Verify:** unit test that a boundary event fires `onCompaction` and does not fall through to text callbacks.
- [x] 1.3 `routes/chat.ts`: wire `onCompaction` → `broadcastToAll({type:"stream:compaction",…})` + persist a marker in its OWN `compaction_markers` table (migration 056) positioned by `afterMessageId` — chosen over a `role:"system"` message row to avoid the `messages.role` CHECK rebuild. **Verify:** `compaction-markers` persistence unit test (in-memory sqlite).
- [x] 1.4 History exclusion is structural: markers live in a separate table and never enter `messages` / `build-provider-history`, so they can never re-reach the model. **Verify:** by construction (no messages row is ever written).
- [x] 1.5 Client: `useChat.ts` handles `stream:compaction` + loads markers from history; new `CompactionDivider.tsx`; `MessageList` folds dividers into the transcript by `afterMessageId` (pure `partitionMarkers`, unit-tested) via `itemContent` so it bypasses the content filter. **Verify:** `partitionMarkers` unit test + client typecheck.
- [ ] 1.6 Honest-silence state: extend `handleGraceExpiry` (`chat.ts:656-671`) to emit `stream:compaction {phase:"in_progress"}` on first grace extension; client swaps `PartialIndicator` for an "ottimizzazione del contesto…" state; clear on boundary/resume. **Verify:** unit test on the timer path (extend `stream-timer.test.ts`).
- [x] 1.7 Persistence rehydration: compaction marker reloads via `loadHistory`. **Verify:** E2E — reload the topic, divider is still there in the right position.
- [ ] 1.8 Harden tail read: cap `Buffer.alloc` in `claude-session-tracker.ts:459-461` at `MAX_TAIL_READ`, advance in bounded chunks on overflow. **Verify:** `bun:test` — a synthetic multi-MB growth is read in ≤ cap-sized chunks; no single giant alloc.

## 2. Slash-command parity (claude-code)

- [ ] 2.1 `client/src/lib/slashCommands.ts`: single source-of-truth table + pure `classify(input)`; drive composer allowlist (`ChatInput.tsx:26-38`), `/help`, and submit dispatcher (`ChatPane.tsx:471-525`) from it. **Verify:** `bun:test` on `classify`.
- [x] 2.2 Un-wire `/model` from openclaw (`topics.ts:2151`): for claude-code, set per-topic model → `refreshSessionConfig` respawn. **Verify:** E2E — `/model claude-opus-4-8` on a claude-code topic returns 200 and the next turn uses it (no 400).
- [x] 2.3 Un-wire `/reasoning` / add `/effort` (`topics.ts:2158`) → per-topic effort respawn. **Verify:** E2E — effort changes without 400.
- [x] 2.4 Real `/clear`: `provider.resetSession(sessionKey)` rotates to a fresh `--session-id` (clears stored resume id, detaches/kills current broker child) + existing DB backup+wipe. La scelta "chi avvisare e come" è pura in `server/routes/clearPolicy.ts` (il difetto era un `sendToSession?.()` che su claude-code era un no-op silenzioso), e lo stesso taglio vale su `/api/chat/abort` quando la chat viene buttata intera. **Verify:** `server/providers/claude-code.reset-session.test.ts` — dopo il reset `getOrCreateClaudeSessionId` torna `isNew: true` con un uuid NUOVO (cioè argv `--session-id`, non `--resume`), le altre sessioni intatte; + `clearPolicy.test.ts` sui prototipi veri dei provider.
- [ ] 2.5 `/context`, `/cost`, `/status`: synthetic replies from `transcript-usage` + context envelope. **Verify:** E2E — each returns a populated reply on a claude-code topic.
- [ ] 2.6 `/compact`: implement per 0.4 outcome (forward if honoured, else documented no-op that surfaces auto-compaction only — never fake). **Verify:** matches the recorded 0.4 decision.
- [ ] 2.7 `/<skill-name>`: known skill → inject Skill invocation; unknown → fall through to model. **Verify:** E2E — a known skill triggers; a random `/foo path` reaches the model unchanged.
- [ ] 2.8 Refresh `/help` from the table. **Verify:** `/help` lists exactly the handled commands.

## 3. Opt-in per-topic permission prompts

- [ ] 3.1 Migration: `topics.permission_prompts` (default 0). **Verify:** migration applies + rolls forward on a fresh DB.
- [ ] 3.2 `resolveClaudeCodePermissionMode` (`app-settings.ts:189`): flag off → `bypassPermissions` (unchanged); flag on → prompting mode from 0.3. **Verify:** `bun:test` — mode resolution both ways.
- [ ] 3.3 `server/providers/claude/control-protocol.ts`: pure decode `control_request` + encode allow/deny/always `control_response`. **Verify:** `bun:test` against 0.3 fixture.
- [ ] 3.4 Provider: detect `control_request` in the stream, fire `onPermissionRequired`; write `control_response` on answer (reuse stdin writer). **Verify:** integration — a fixture request produces a matching response frame.
- [ ] 3.5 Route + client: `stream:permission_required`; `waiting_for_permission` status; allow/deny/always card in `ToolCallRow`/`ToolInputForm`; answer via extended `POST /api/chat/tool-response`; "always" persists per-session. **Verify:** E2E on an opt-in topic — allow → tool runs; deny → tool blocked; card survives reload.
- [ ] 3.6 Safety: unanswered request bounded by hard timeout → deny+finalize (never auto-allow). **Verify:** unit test on the timeout path.

## 4. Out-of-turn render (render-only)

- [ ] 4.1 `server/providers/claude/out-of-turn.ts`: pure classifier (background-task done / Monitor notification / ignore). **Verify:** `bun:test`.
- [ ] 4.2 Provider: post-turn listener routes recognisable events with no active `streamHandler` to `onOutOfTurn` instead of dropping. **Verify:** integration — an event after `result` reaches `onOutOfTurn`.
- [ ] 4.3 Route + persistence: `stream:out_of_turn` broadcast + `role:"system" kind:"background"` row (excluded from provider history). **Verify:** row written + not in assembled history.
- [ ] 4.4 Client: render as a muted system entry in the message list; existing `useCompletionNotifier` toast unchanged; **no** model auto-resume. **Verify:** E2E — Monitor completion appears inline; no new turn starts.
- [x] 4.5 Tool-detail rows for the tools that today fall through `deriveToolDetail` to `type:"unknown"` (`tool-detail.ts:209`): `Monitor`, `BashOutput`, `KillShell`/`KillBash`, background (`run_in_background`) Bash, plus `NotebookEdit`, `Skill`, `SlashCommand`, `LSP`. Add the missing name aliases + typed shapes (server `tool-detail.ts`) and their cards (client `ToolCards.tsx`). **Verify:** `bun:test` on `deriveToolDetail` for each name; each renders as a typed row, not the raw `unknown` JSON card.

## 5. Broker survival — spec, verify, observe

- [ ] 5.1 Verify prod default-on: assert `start-prod.sh` / `~/.topics-server-env` never set `TOPICS_AI_BRIDGE=0`; add a boot log + startup self-check that the broker socket is reachable. **Verify:** boot log shows broker active on prod path.
- [ ] 5.2 Diagnostics: expose `ai-bridge-client.list()` (live/adopted/reaped sessions, store bytes, orphan-grace) via a read-only endpoint + a small system-status panel. **Verify:** panel shows current sessions; matches `client.list()`.
- [ ] 5.3 Regression guard: a test that a provider "restart" (two instances sharing the singleton broker) adopts a mid-turn session rather than re-running it (extend existing `claude-code-reattach.test.ts`). **Verify:** test passes.

## 6. Sticky todo strip (minor)

- [x] 6.1 Render latest `TodoWrite` in `ChatPane` `aboveInputSlot` (L763) as a compact, collapsible, in-place strip. **Verify:** E2E — strip updates as todos change; inline rows unaffected.

## 8. Rendering performance (CHAT-PERF-01)

- [x] 8.1 Coalesce live deltas: the `stream:content_chunk` / `stream:thinking_chunk` handlers in `useChat.ts` buffer into a ref and flush via a single `requestAnimationFrame` (the foreground SSE path already batches per read-cycle — this brings the cross-window WS path to parity). Any non-delta event flushes synchronously first so the `blocks` timeline stays ordered. **Verify:** client Chat/hooks unit suite green (71 pass).
- [ ] 8.2 Scope markdown re-parse to the in-flight bubble: confirm `MessageBubble` memo bailout holds during streaming so only the streaming row re-renders; if the streaming bubble re-highlights on every delta, memoize the parsed/highlighted markdown on `(content, isStreaming)` so settled rows never re-parse. **Verify:** React profiler / render-count test — a streamed delta re-renders exactly one bubble, and settled bubbles' markdown is not re-parsed.
- [x] 8.3 Clamp oversized bodies: `ClampedPre` + pure `clampBody` cap inline result bodies at ~20 KB behind a "Mostra tutto (N KB)" toggle; routed through every result-bearing card (shell/bash_output/fetch/mcp/unknown/sub_agent + the new harness cards). **Verify:** `clampBody` unit test (5 pass) + client typecheck.
- [ ] 8.4 Guard the virtualization invariant: `MessageList` stays virtualized with no full-list re-render per streamed delta on a long transcript. **Verify:** perf test / profiler on a long-history topic during streaming.

## 7. Close-out

- [ ] 7.1 Full `bun:test` + `typecheck:server` + `check:any` green. **Verify:** command output.
- [ ] 7.2 Playwright E2E for all UI flows green (isolated test server :13334). **Verify:** report.
- [ ] 7.3 Durable preview evidence per board protocol: a `.webm` clip of the compaction divider appearing + persisting, a permission allow/deny round-trip, and a Monitor inline entry. **Verify:** clips attached to the task.
