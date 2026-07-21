# Design: chat-claude-code-parity

## Guiding constraints

- The chat provider is the **real** `claude` CLI in headless stream-json mode (`server/providers/claude-code.ts` `spawnPersistentProcess`, argv ~L1374-1403). Every feature here is either (a) surfacing an event the CLI already emits, or (b) driving an input the CLI already accepts — never a reimplementation of model behaviour.
- **The SQLite `messages` table is the UI source of truth** (`server/utils/build-provider-history.ts`, `server/routes/history.ts`). New UI-only rows (compaction marker, out-of-turn system entries) are persisted there but MUST be excluded from provider-history assembly so they never re-enter the model's context.
- **Do not rewrite the broker.** `server/ai-bridge.mjs` + `server/lib/ai-bridge-client.ts` + the boot adopt/reap (`server.ts:813-853, 1745-1788`) stay as-is; this change specs, verifies, hardens, and observes them.
- Wire shapes owned by the compiled CLI (`compact_boundary`, control protocol) are treated as **verify-then-parse-defensively**: Task 0 captures the real events from v2.1.216 before the parsers are finalised; every parser degrades gracefully on unknown/missing fields.

---

## 0. Turn-finalization solidity (root cause of "streams then deletes the message")

Live forensics on production (`data/topics.db`): **36 assistant messages across 27 topics** carry the fingerprint `content=''` + `latency_ms=NULL` + large `blocks` — i.e. a turn that did work but was finalized with no text. Repro on topic `topic:6b99e9cf` ("quadra"): the error log shows soft-timeout → grace-extended-while-alive → **`Hard timeout (30 min)`** → `[claude-code] Message timed out … killing process` → `Error: Message timed out after 30 minutes`.

Two structural defects combine:

1. **Full-row read-modify-write clobber.** `updateLastMessage` / `appendToLastMessage` / `updateToolCallResult` / `updateBlockTool` / `finalizeStream` all do `row = getLastMessage(sessionKey)` → mutate one field → `stmts.updateMessage.run({...ALL columns...})` (`server/utils.ts:205-206` — `UPDATE messages SET content=$content, thinking=$thinking, tool_calls=$tool_calls, …`, no COALESCE). So every tool/block write re-persists `content` from its own snapshot. When a killed process flushes a burst of late `tool_result`s, each rewrites `content=''`, erasing both the streamed prose and the finalize warning. Even without a timeout, a `tool_result` write that snapshotted just before a content delta zeroes the text on a heavy turn.
   - **Fix**: field-isolated writes. The scoped statements already exist (`appendMessageContent: UPDATE messages SET content=? WHERE id=?`, and `UPDATE messages SET tool_calls=? WHERE id=?` at `utils.ts:1006`). Route tool/block updates through column-scoped SQL that touches only `tool_calls`/`blocks`, never `content`/`thinking`. Add a `finalized` latch on the row so post-finalization writes cannot re-touch `content`.

2. **Two racing 30-minute timeouts that KILL.** `STREAM_HARD_TIMEOUT_MS` (chat.ts `handleHardTimeout`) and `MESSAGE_TIMEOUT_MS` (claude-code.ts:47, `handler.onError("Message timed out after 30 minutes")` + kill) both fire ~together and both finalize the same turn; neither sets `latency_ms` (hence NULL). For a chat replacing the CLI, a 30-min wall-clock kill is wrong for a turn that is alive and emitting tool events.
   - **Fix**: one authoritative duration cap. Reset it on genuine tool progress (a `tool_start`/`tool_result` is progress, not silence). Keep a hard ceiling for a truly silent+wedged turn, but make the finalize **non-destructive**: persist the accumulated text/blocks + an explicit "[interrotto dopo N min]" marker; never overwrite with empty.

3. **Client render fallback.** When `content===''` but `blocks` is non-empty, render the blocks timeline (+ an "interrotto" chip), never an empty/vanishing bubble. `MessageList` filter must not drop a blocks-bearing empty-content assistant row.

This is foundational to pillar ① ("che siano solide") and lands first — the compaction "in-progress" state (§1.6) rides on the same finalize path.

---

## 1. Compaction — surface, persist, render, honest silence

### 1.1 Intercept point
Single hook: `server/providers/claude-code.ts:1640`, currently

```ts
if (event.type === "system" || event.type === "rate_limit_event") return;
```

Insert a branch **before** the drop:

```ts
if (event.type === "system") {
  if (event.subtype === "compact_boundary") this.handleCompactBoundary(pp, event);
  return; // still drop all other system events (init/rate-limit noise)
}
if (event.type === "rate_limit_event") return;
```

### 1.2 Expected event shape (VERIFY in Task 0)
Documented/expected shape — parse defensively, all fields optional:

```jsonc
{ "type": "system", "subtype": "compact_boundary",
  "compact_metadata": { "trigger": "auto" | "manual", "pre_tokens": 154213 },
  "session_id": "…", "uuid": "…" }
```

A pure decoder `parseCompactBoundary(event): CompactionMarker | null` lives in a new `server/providers/claude/compaction.ts` (unit-tested). It returns `{ trigger, preTokens?, at }` and `null` when the event is not a recognisable boundary (→ caller falls back to a generic marker with no token counts). Never throw.

### 1.3 New provider hook + stream event
- `server/providers/types.ts` `StreamHandler`: add `onCompaction?(marker: CompactionMarker): void`.
- `handleCompactBoundary` calls `pp.streamHandler?.onCompaction(marker)` and bumps the stream activity (`updateStreamContent`) so the StaleStream sweeper never reaps a compacting turn.
- `server/routes/chat.ts` wires `onCompaction` → (a) `broadcastToAll({ type: "stream:compaction", sessionKey, marker })` and (b) persists a marker row (§1.4).

### 1.4 Persistence
A compaction marker is a `messages` row with `role: "system"` and a discriminating `kind: "compaction"` (JSON in the existing metadata/content column — no schema change to the table; the per-topic permission flag in §3 is the only migration). The row carries `{ trigger, preTokens, postTokens?, at }`. `postTokens` is filled from the next `result` usage if available.

`build-provider-history` MUST skip `role:"system"` `kind:"compaction"` rows (and the out-of-turn rows in §4) when assembling provider memory — they are display-only.

### 1.5 Client render
- `client/src/hooks/useChat.ts` `handleStreamEvent`: add `stream:compaction` → insert/attach a compaction block into the timeline; `loadHistory` already re-reads the DB, so a persisted marker rehydrates on reload.
- New `client/src/components/Chat/CompactionDivider.tsx`: a horizontal rule + centred pill — `⟐ Contesto compattato · 154k → 32k token · auto`. Optional expandable summary when present. Rendered from a new `ContentBlock` kind `compaction` in `MessageContent.tsx`'s blocks timeline (L1003+), and as a standalone `role:"system"` row in `MessageBubble.tsx` when it arrives as its own message (mirror the existing user/assistant branch at L263-268 with a system/compaction branch).
- `client/src/components/MessageList.tsx` filter (L129-140) must let `role:"system" kind:"compaction"` rows through.

### 1.6 Honest silence ("compattazione in corso")
Today `handleGraceExpiry` (`chat.ts:656-671`) silently re-arms grace while `isTurnProcessAlive`. Extend it: on the FIRST grace extension of a turn, broadcast `stream:compaction` with `phase:"in_progress"` (distinct from the boundary marker) so the chat swaps the generic `PartialIndicator` for a "compattazione del contesto in corso…" state. When the boundary arrives (or the turn resumes emitting), clear it. This is heuristic (long silence ≠ always compaction) so the copy is soft ("ottimizzazione del contesto…") and it never blocks Stop.

### 1.7 Hardening the tail read
`server/lib/claude-session-tracker.ts:459-461` reads the whole unconsumed tail into `Buffer.alloc(len)` synchronously. On a multi-MB compact rewrite this spikes memory. Cap the single read (e.g. `MAX_TAIL_READ = 4 MB`); on overflow, advance the offset in bounded chunks across successive sweeps instead of one giant allocation. Pure size math → unit-tested.

---

## 2. Slash-command parity (claude-code)

Interception stays a two-layer allowlist (composer `ChatInput.tsx`, submit `ChatPane.tsx:471-525`, server `POST /api/command` `topics.ts:2125-2217`). Unmatched `/x` still falls through to the model verbatim.

| Command | Handling |
|---|---|
| `/model <m>` | Drop the `openclaw`-only guard (`topics.ts:2151`). For claude-code, route to the existing respawn path: set the per-topic model (PATCH semantics) → `refreshSessionConfig` respawn with new `--model` (`claude-code.ts:1209`). Same code the UI picker already uses. |
| `/reasoning` / `/effort <t>` | Same: drop the guard (`topics.ts:2158`), set per-topic effort → respawn with `--effort` (migration 033 already exists). |
| `/clear` | Real reset: keep today's DB backup+wipe, AND rotate the CLI session — next spawn uses a fresh `--session-id` instead of `--resume <old>` (a new `provider.resetSession(sessionKey)` that clears the stored resume id and detaches/kills the current broker child so the next `sendChat` starts clean). Matches CLI `/clear` (drops model memory, keeps nothing). |
| `/compact` | Best-effort. Task 0 tests whether the headless CLI honours `/compact` sent as a stream-json `user` message. If yes → forward and show the resulting `compact_boundary` (§1). If no → document as unsupported headless and expose only the auto-compaction indicator; do NOT fake a compaction. |
| `/context` | Synthetic assistant/system reply built from the app's existing context envelope + `transcript-usage` (token budget, % used) — the data behind `ContextRing` already exists. |
| `/cost` | Synthetic reply from `transcript-usage` session cost/token totals (already tracked for the board). |
| `/status` | Already handled (`commandApi.status`); extend to include provider/model/effort/permission-mode. |
| `/help` | Local text; regenerate the list from the real allowlist so it can't drift. |
| `/<skill-name>` | If the token matches a known skill, inject a Skill invocation for the model (or a canned user turn that triggers it). If unknown → fall through to the model (today's behaviour). |

`/agents /pause /resume /assign` stay on the board-chat route (`chat.ts:150-294`) — unchanged.

A single source-of-truth table `client/src/lib/slashCommands.ts` (pure) drives the composer allowlist, the `/help` text, and the submit dispatcher, so the three can't diverge. Unit-tested: classify(input) → `{ handledBy: "client"|"server"|"model", command, args }`.

---

## 3. Opt-in per-topic permission prompts

### 3.1 Flag
Migration: `topics.permission_prompts INTEGER NOT NULL DEFAULT 0`. `resolveClaudeCodePermissionMode` (`server/services/app-settings.ts:189`) already resolves a mode; extend it to honour the per-topic flag: flag off → `bypassPermissions` (today's default, unchanged); flag on → a prompting mode (`default`, or the CLI's `manual`) that emits control requests.

### 3.2 Control protocol (VERIFY in Task 0)
In stream-json mode the CLI requests permission via a control request over stdout and expects a response on stdin. Expected shape — verify + parse defensively:

```jsonc
// CLI → us (stdout)
{ "type": "control_request", "request_id": "…",
  "request": { "subtype": "can_use_tool", "tool_name": "Bash",
               "input": { "command": "rm -rf …" },
               "permission_suggestions": ["allow_once","allow_always","deny"] } }
// us → CLI (stdin)
{ "type": "control_response", "request_id": "…",
  "response": { "subtype": "success",
                "response": { "behavior": "allow", "updatedInput": { … } } } }
//        or { "behavior": "deny", "message": "user declined" }
```

`server/providers/claude/control-protocol.ts` (pure codec: decode request, encode allow/deny/always response) — unit-tested. Reuse the existing NDJSON-stdin writer (`sendChatInternal` writes `{"type":"user",…}` at `claude-code.ts:1009-1012`; control responses go through the same stdin).

### 3.3 UI round-trip
Model the permission request on the tested `waiting_for_input` path (§ AskUserQuestion): provider fires a new `onPermissionRequired(req)` (`types.ts`), route broadcasts `stream:permission_required` (`chat.ts`), client sets tool status `waiting_for_permission` and renders an allow / deny / **always allow this tool** card in `ToolCallRow.tsx` / `ToolInputForm.tsx`. The answer posts to `POST /api/chat/tool-response` (extended to carry a permission decision) → provider writes the `control_response`. "Always" persists into the per-session allowed set so the CLI stops asking. Survives reattach exactly like `waiting_for_input` (`reattach()` returns an awaiting state).

### 3.4 Safety
Opt-in only. An unanswered request is bounded by the existing 30-min hard timeout (`chat.ts` `handleHardTimeout`). Never auto-allow on timeout — timeout → deny + finalize.

---

## 4. Out-of-turn render (render-only)

### 4.1 The boundary
`handleStreamEvent` treats `result` (`claude-code.ts:1648`) as the turn end and nulls `pp.streamHandler`. Events after `result` (Monitor notifications, background-Bash completions) currently hit a null handler → dropped.

### 4.2 Channel
Keep a lightweight **post-turn listener** on the persistent process (the child lives on in the broker between turns). When a recognisable out-of-turn event arrives with no active `streamHandler`, route it to a new `onOutOfTurn(event)` provider hook instead of dropping it. Classification (pure, unit-tested `server/providers/claude/out-of-turn.ts`): background-task completion, Monitor notification, or ignorable. Only render-worthy classes are forwarded.

### 4.3 Surfacing (render-only, NO auto-resume)
- Route broadcasts `stream:out_of_turn` and persists a `role:"system"` `kind:"background"` marker row (excluded from provider history, §1.4).
- Client renders it as a distinct system entry in the message list (a muted "◷ Monitor: deploy completato" / "Task in background terminato" line) — new branch in `MessageContent`/`MessageBubble` alongside the compaction branch. The existing `useCompletionNotifier` toast still fires.
- The model is **not** re-invoked. If the user wants to act on it, they send a message (the CLI child already has the event in its own context on the next turn).

### 4.4 Tool detail for Monitor / background Bash
`server/providers/claude/tool-detail.ts` + client `toolDetail.ts`: add cases so `Monitor`, `BashOutput`, `KillShell`, and `run_in_background` Bash render as typed rows (label, target, live/'done' status) instead of the generic `unknown` row.

---

## 5. Broker survival — spec, verify, observe

- **Spec**: capture the detached-daemon contract (child survives server reload/crash; boot adopts mid-turn, reaps idle; reattach replays) as CHAT-PROC-01 so it is protected against regression.
- **Verify prod default-on**: `USE_AI_BRIDGE = TOPICS_AI_BRIDGE==="1" || (TOPICS_AI_BRIDGE!=="0" && platform!=="win32")` (`claude-code.ts:634-635`) is already default-on on macOS. Task: assert `~/.topics-server-env` / `start-prod.sh` does not set `TOPICS_AI_BRIDGE=0`, and add a boot log line + a startup self-check that the broker socket is reachable.
- **Observe**: expose `client.list()` (live / adopted / reaped sessions, store bytes, orphan-grace countdown) via an existing diagnostics endpoint and a small panel (system-status surface). Read-only.

---

## 6. Sticky todo strip (minor)

`ChatPane.tsx:763` already has an `aboveInputSlot`. Render the latest `TodoWrite` detail (the most recent `type:"todo"` block in the session) there as a compact, collapsible strip ("3/7 · in corso: …"), updating in place. Inline transcript rows stay as they are.

---

## 7. Test matrix

- **bun:test (pure)**: `compaction.ts` (boundary decode incl. missing fields), `control-protocol.ts` (request decode + allow/deny/always encode), `slashCommands.ts` (classify), `out-of-turn.ts` (classify), tail-read cap math, `build-provider-history` exclusion of system markers.
- **Task-0 capture harness**: a script that runs the installed CLI headless with a scripted stream-json session and records the real `compact_boundary` and `control_request` frames into fixtures the pure tests load.
- **Playwright E2E**: compaction divider appears mid-turn and persists across reload; `/model <x>` switches model on a claude-code topic (no 400); `/clear` starts a fresh session; permission card allow→tool runs, deny→tool blocked (opt-in topic); Monitor completion renders as a system entry without resuming the model.

---

## 8. Phasing (implementation order within the one change)

1. **Task 0 — empirical capture** of `compact_boundary` + control protocol frames from v2.1.216 → fixtures. Everything else depends on knowing the real shapes.
2. **Compaction (cap. 1)** — highest-visibility, self-contained, low risk.
3. **Slash parity (cap. 2)** — un-wire model/reasoning, real /clear, context/cost/help, skills.
4. **Out-of-turn render (cap. 4)** + tool-detail rows.
5. **Permission prompts (cap. 3)** — opt-in, control protocol.
6. **Broker spec/verify/observe (cap. 5)** + **sticky todo (cap. 6)**.

Each phase ships behind its own tests and is independently reviewable; the change is not "done" until all phases and the E2E suite pass.

## 9. Decisions deferred to implementation

- Whether `/compact` is honoured headless (Task 0 decides §2).
- Exact permission-mode string that emits control requests on v2.1.216 (`default` vs `manual`) — Task 0.
- Whether the compaction "in-progress" state also lights a distinct tab/aura indicator (claude-sessions phase) or stays chat-only — chat-only for v1 to bound coupling.
