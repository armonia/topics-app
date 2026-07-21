# Tasks: chat-claude-code-parity

Each task lists its verification. The change is complete only when every box is checked and the E2E suite passes. Work on a branch off `main` (a worktree per the board protocol).

## 0. Empirical capture (blocks everything — real wire shapes)

- [ ] 0.1 Build a headless capture harness: run the installed `claude` (v2.1.216) with `--input-format stream-json --output-format stream-json` and record raw frames. **Verify:** fixtures saved under `server/providers/claude/__fixtures__/`.
- [ ] 0.2 Capture a real `system`/`compact_boundary` frame (force via a large scripted context or `/compact` if honoured). **Verify:** fixture exists; note the exact `subtype` + metadata field names.
- [ ] 0.3 Capture the permission `control_request` frame with a prompting permission mode, and confirm which `--permission-mode` value emits it (`default` vs `manual`). **Verify:** fixture + documented mode string in `design.md §9`.
- [ ] 0.4 Determine empirically whether `/compact` sent as a stream-json `user` message triggers compaction. **Verify:** result recorded in `design.md §2` (`/compact` row resolved to supported/unsupported).

## S. Turn-finalization solidity (lands FIRST — fixes live "message disappears")

- [ ] S.1 Field-isolated persistence: route `updateToolCallResult` / `updateBlockTool` through column-scoped SQL (`tool_calls`/`blocks` only), never rewriting `content`/`thinking`. **Verify:** `bun:test` — interleaved content-delta + tool-result writes both survive (no clobber).
- [ ] S.2 `finalized` latch on the message row: once a turn is finalized, later writes cannot re-touch `content`/`thinking`. **Verify:** unit test — a late `tool_result` after finalize does not zero content.
- [ ] S.3 Non-destructive finalize on timeout/error/abort: persist accumulated text + blocks + an explicit "[interrotto/timeout]" marker atomically; never empty. **Verify:** integration — a killed heavy turn keeps its blocks + marker, `content` non-empty.
- [ ] S.4 Unify the two 30-min timeouts into one authoritative duration cap that resets on tool progress; keep a silent-turn ceiling but finalize non-destructively (no process-kill that discards output). **Verify:** unit test — a turn emitting tool events past 30 min is not killed; a fully silent turn still bounded.
- [ ] S.5 Client: render the blocks timeline (+ "interrotto" chip) when `content===''` but blocks exist; `MessageList` filter keeps blocks-bearing empty-content rows. **Verify:** E2E — a timed-out turn shows its tool timeline, does not vanish.
- [ ] S.6 One-off data note: the 36 existing empty rows are historical; no migration needed (display fallback S.5 covers them). **Verify:** loading an affected topic (e.g. `topic:0f704cab`) shows the tool timeline, not a blank.

## 1. Compaction — surface, persist, render, honest silence

- [ ] 1.1 `server/providers/claude/compaction.ts`: pure `parseCompactBoundary(event)` → `CompactionMarker | null`, defensive on missing fields. **Verify:** `bun:test` against 0.2 fixture + malformed inputs.
- [ ] 1.2 `claude-code.ts:1640`: branch `compact_boundary` before the `system` drop → `handleCompactBoundary` → `onCompaction` hook (`types.ts`) + StaleStream bump. **Verify:** unit test that a boundary event fires `onCompaction` and does not fall through to text callbacks.
- [ ] 1.3 `routes/chat.ts`: wire `onCompaction` → `broadcastToAll({type:"stream:compaction",…})` + persist a `role:"system" kind:"compaction"` `messages` row (postTokens backfilled from next `result`). **Verify:** integration test row is written + broadcast emitted.
- [ ] 1.4 `build-provider-history.ts`: exclude `role:"system"` marker rows from provider memory. **Verify:** `bun:test` — assembled history omits compaction/background rows.
- [ ] 1.5 Client: `useChat.ts` handle `stream:compaction`; new `CompactionDivider.tsx`; render as `ContentBlock kind:"compaction"` in `MessageContent.tsx` timeline and as a `role:"system"` row in `MessageBubble.tsx`; let it through `MessageList` filter. **Verify:** E2E — divider shows pre→post tokens.
- [ ] 1.6 Honest-silence state: extend `handleGraceExpiry` (`chat.ts:656-671`) to emit `stream:compaction {phase:"in_progress"}` on first grace extension; client swaps `PartialIndicator` for an "ottimizzazione del contesto…" state; clear on boundary/resume. **Verify:** unit test on the timer path (extend `stream-timer.test.ts`).
- [ ] 1.7 Persistence rehydration: compaction marker reloads via `loadHistory`. **Verify:** E2E — reload the topic, divider is still there in the right position.
- [ ] 1.8 Harden tail read: cap `Buffer.alloc` in `claude-session-tracker.ts:459-461` at `MAX_TAIL_READ`, advance in bounded chunks on overflow. **Verify:** `bun:test` — a synthetic multi-MB growth is read in ≤ cap-sized chunks; no single giant alloc.

## 2. Slash-command parity (claude-code)

- [ ] 2.1 `client/src/lib/slashCommands.ts`: single source-of-truth table + pure `classify(input)`; drive composer allowlist (`ChatInput.tsx:26-38`), `/help`, and submit dispatcher (`ChatPane.tsx:471-525`) from it. **Verify:** `bun:test` on `classify`.
- [ ] 2.2 Un-wire `/model` from openclaw (`topics.ts:2151`): for claude-code, set per-topic model → `refreshSessionConfig` respawn. **Verify:** E2E — `/model claude-opus-4-8` on a claude-code topic returns 200 and the next turn uses it (no 400).
- [ ] 2.3 Un-wire `/reasoning` / add `/effort` (`topics.ts:2158`) → per-topic effort respawn. **Verify:** E2E — effort changes without 400.
- [ ] 2.4 Real `/clear`: `provider.resetSession(sessionKey)` rotates to a fresh `--session-id` (clears stored resume id, detaches/kills current broker child) + existing DB backup+wipe. **Verify:** integration — after `/clear`, next spawn argv has `--session-id` (new uuid), not `--resume`.
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
- [ ] 4.5 Tool-detail rows for the tools that today fall through `deriveToolDetail` to `type:"unknown"` (`tool-detail.ts:209`): `Monitor`, `BashOutput`, `KillShell`/`KillBash`, background (`run_in_background`) Bash, plus `NotebookEdit`, `Skill`, `SlashCommand`, `LSP`. Add the missing name aliases + typed shapes (server `tool-detail.ts`) and their cards (client `ToolCards.tsx`). **Verify:** `bun:test` on `deriveToolDetail` for each name; each renders as a typed row, not the raw `unknown` JSON card.

## 5. Broker survival — spec, verify, observe

- [ ] 5.1 Verify prod default-on: assert `start-prod.sh` / `~/.topics-server-env` never set `TOPICS_AI_BRIDGE=0`; add a boot log + startup self-check that the broker socket is reachable. **Verify:** boot log shows broker active on prod path.
- [ ] 5.2 Diagnostics: expose `ai-bridge-client.list()` (live/adopted/reaped sessions, store bytes, orphan-grace) via a read-only endpoint + a small system-status panel. **Verify:** panel shows current sessions; matches `client.list()`.
- [ ] 5.3 Regression guard: a test that a provider "restart" (two instances sharing the singleton broker) adopts a mid-turn session rather than re-running it (extend existing `claude-code-reattach.test.ts`). **Verify:** test passes.

## 6. Sticky todo strip (minor)

- [ ] 6.1 Render latest `TodoWrite` in `ChatPane` `aboveInputSlot` (L763) as a compact, collapsible, in-place strip. **Verify:** E2E — strip updates as todos change; inline rows unaffected.

## 8. Rendering performance (CHAT-PERF-01)

- [ ] 8.1 Coalesce live deltas: the `stream:content_chunk` / `stream:thinking_chunk` handlers in `useChat.ts` (~L480-546) accumulate into a ref and flush via a single `requestAnimationFrame`-batched `setMessages`, instead of one commit per delta (the catchup path at ~L923-989 already batches — bring the live path to parity). **Verify:** unit/bench — N deltas in one frame produce 1 commit; the streamed text is identical to per-delta.
- [ ] 8.2 Scope markdown re-parse to the in-flight bubble: confirm `MessageBubble` memo bailout holds during streaming so only the streaming row re-renders; if the streaming bubble re-highlights on every delta, memoize the parsed/highlighted markdown on `(content, isStreaming)` so settled rows never re-parse. **Verify:** React profiler / render-count test — a streamed delta re-renders exactly one bubble, and settled bubbles' markdown is not re-parsed.
- [ ] 8.3 Clamp oversized bodies: a very large tool result or message body is collapsed with an expand control (cap inline layout), so a multi-MB Bash/BashOutput result doesn't wedge layout. **Verify:** E2E — a synthetic large output renders collapsed with a working expand.
- [ ] 8.4 Guard the virtualization invariant: `MessageList` stays virtualized with no full-list re-render per streamed delta on a long transcript. **Verify:** perf test / profiler on a long-history topic during streaming.

## 7. Close-out

- [ ] 7.1 Full `bun:test` + `typecheck:server` + `check:any` green. **Verify:** command output.
- [ ] 7.2 Playwright E2E for all UI flows green (isolated test server :13334). **Verify:** report.
- [ ] 7.3 Durable preview evidence per board protocol: a `.webm` clip of the compaction divider appearing + persisting, a permission allow/deny round-trip, and a Monitor inline entry. **Verify:** clips attached to the task.
