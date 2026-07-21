# Change: chat-claude-code-parity

## Why

The topic **chat** is supposed to be a drop-in replacement for the terminal Claude Code CLI — "everything is there". Under the hood it already is the real thing: `server/providers/claude-code.ts` spawns `claude --print --input-format stream-json --output-format stream-json --include-partial-messages` (one child per `sessionKey`), and the child is kept alive across server reload/crash by the detached `ai-bridge` broker daemon (adopt/reap/reattach are implemented and tested). So model-level behaviour — tools, `Task` sub-agents, `Explore`, `TodoWrite`, thinking, MCP, auto-compaction — already flows into the chat and is largely rendered.

But three structural gaps break the "replace the CLI" promise, and they are exactly the things a user notices:

1. **Compaction is invisible.** The CLI auto-compacts internally; `server/providers/claude-code.ts:1640` drops **every** `system` event with an early `return` (`if (event.type === "system" || event.type === "rate_limit_event") return;`), and `{type:"system", subtype:"compact_boundary"}` is a `system` event. The client has no compaction branch at all (`MessageBubble.tsx`, `MessageContent.tsx`). Result: a 3-minute compaction is indistinguishable from a slow turn — the user sees only a spinner, then output, with no "history compacted" marker, no pre/post token signal, nothing persisted in the thread. The watchdog already *tolerates* the silence (grace re-armed while `isTurnProcessAlive`), so the turn is robust — it is only invisible.

2. **Most slash commands are dead.** The composer intercepts a 7-command app allowlist (`ChatInput.tsx:26-38`, `ChatPane.tsx:471-525`); everything else is sent to the model as literal prose. Worse, `/model` and `/reasoning` are hard-wired to the `openclaw` provider (`topics.ts:2151,2158`) and return HTTP 400 on a claude-code chat, and `/clear` is a no-op for claude-code (`sendToSession` is unimplemented — it wipes the local message table but never resets the CLI session). `/compact`, `/context`, `/cost`, and skill invocations (`/deep-research` …) do nothing.

3. **Nothing survives the turn boundary.** The chat is strictly turn-based: `result` (`claude-code.ts:1648`) ends the turn and nulls the stream handler. Anything that arrives *after* `result` — a `Monitor` notification, a `run_in_background` Bash completion — has nowhere to go and is effectively dropped. In the terminal CLI these wake the session; in the chat they vanish.

A fourth, softer gap: for full CLI fidelity some users want an **allow/deny permission gate**, which the chat deliberately bypasses today (`--permission-mode bypassPermissions`). And the detached-broker survival that pillar (2) relies on is real but **unspecced and unobservable** — it has no requirement protecting it and no UI showing daemon state.

## What changes

1. **Compaction — surfaced, persisted, rendered, and honest during the silence.** Intercept `compact_boundary` *before* the `system` drop, extract its metadata (trigger `auto`/`manual`, `pre_tokens`), broadcast a new `stream:compaction` event, and persist a first-class compaction marker into the DB thread so it survives reload and appears in history. The client renders a "Contesto compattato" divider (pre→post tokens, optional summary). During the silent compaction window the chat shows an explicit **"compattazione in corso"** state instead of the generic spinner (driven off the existing `handleGraceExpiry` liveness branch). Harden the one real robustness edge: the synchronous `Buffer.alloc(len)` full-tail read in `claude-session-tracker.ts:459-461` must cap/stream on a giant compact-rewrite.

2. **Slash-command parity for claude-code.** Un-wire `/model` and `/reasoning` from the openclaw-only guard and route them to the existing respawn path (`PATCH /api/topics/:id` → `refreshSessionConfig`). Make `/clear` real by rotating the session id (fresh `--session-id` instead of `--resume`). Add `/context`, `/cost`, `/status` mapped onto data the app already has (`ContextRing`, `transcript-usage`). Add `/compact` (best-effort, driven by an empirically-verified matrix of what the headless CLI honours; documented fallback if it honours nothing). Route `/<skill-name>` to a Skill invocation. Refresh `/help`.

3. **Opt-in per-topic permission prompts.** Default stays `bypassPermissions` (zero regression). A new per-topic flag, when enabled, spawns with a prompting permission mode and drives the stream-json **control protocol**: a `control_request` (`can_use_tool`) surfaces as a `stream:permission_required` event and an allow / deny / always card in the chat, reusing the `waiting_for_input` + `POST /api/chat/tool-response` plumbing; the answer is written back as a `control_response`.

4. **Out-of-turn render (render-only).** Add a channel for events that arrive after `result`. `Monitor` and background-task completions render as **system entries inline** in the message list (plus the existing `useCompletionNotifier` toast). The model is **not** auto-resumed — no autonomous loops. Give `Monitor` / `BashOutput` / `run_in_background` tool rows real detail rendering instead of the generic `unknown` row.

5. **Broker survival — specced, hardened, observable.** Capture the existing detached-daemon survival contract as a protected requirement, verify it is genuinely default-on in production (not silently disabled by `TOPICS_AI_BRIDGE=0`), and surface daemon state (live / adopted / reaped sessions) in the diagnostics UI.

6. **(minor) Sticky current-todo strip.** Render the latest `TodoWrite` in the composer's `aboveInputSlot` (`ChatPane.tsx:763`) as a persistent strip, not only as an inline transcript row.

## Out of scope

- The **PTY terminal** Claude surface (`server/routes/terminal.ts`, `pty-bridge.mjs`) — it is separate, fully interactive, and already has native slash commands and permission prompts. It is only a parity reference here.
- The **openclaw** provider path (`/model`/`/reasoning` on openclaw keep their current behaviour).
- **Auto-continue** for Monitor / background tasks (re-invoking the model out-of-turn). Explicitly deferred — render-only for now.
- Rewriting the ai-bridge broker. Its adopt/reap/reattach machinery stays; this change only specs, verifies, hardens, and observes it.

## Risks

- **`compact_boundary` wire shape drift.** The exact fields of the `system`/`compact_boundary` event and of the permission control protocol are owned by the compiled CLI (v2.1.216) and may differ from the documented shape. Mitigation: a verification task captures the real events, and both parsers are defensive (unknown/missing fields degrade to a generic "context compacted" marker / a raw permission label, never a crash).
- **Persisting a synthetic marker into the thread.** A compaction marker and out-of-turn system entries are new non-`user`/`assistant` rows. They must not break `build-provider-history` (which assembles provider memory from the DB) — markers are UI-only and excluded from provider history assembly.
- **Slash interception swallowing legitimate prose.** A message that merely starts with `/` (e.g. a path) must still reach the model. Interception stays an explicit allowlist + exact-prefix match; anything unmatched falls through to the model unchanged (today's behaviour).
- **Permission prompts hanging a turn.** A prompting mode with no responder deadlocks the turn. Mitigation: the gate is opt-in, the control-request round-trip reuses the tested `waiting_for_input` reattach path, and an unanswered request is bounded by the existing hard timeout.
- **Session-id rotation on `/clear` losing history.** Rotating `--session-id` starts a fresh CLI transcript. Mitigation: the DB thread (UI source of truth) is backed up exactly as today's `/clear` already does before wiping; rotation only affects the model's memory, matching CLI `/clear` semantics.

## Impact

- **Specs (delta)**: `chat/` — ADDED CHAT-COMPACT-01, CHAT-SLASH-01, CHAT-PERM-01, CHAT-OOT-01, CHAT-PROC-01, CHAT-TODO-01; MODIFIED CHAT-01 (message lifecycle admits system/compaction rows) and CHAT-TOOL-01 (tool rows cover Monitor/background + permission states).
- **Server**: `providers/claude-code.ts` (compaction intercept, control protocol, out-of-turn channel, `/clear` session rotation, defensive tail read), `providers/types.ts` (new `StreamHandler` hooks), `routes/chat.ts` (new `stream:compaction` / `stream:permission_required` / out-of-turn broadcasts), `routes/topics.ts` (`/api/command` un-wired from openclaw + new commands), `lib/claude-session-tracker.ts` (capped tail read), `services/app-settings.ts` (per-topic permission flag resolution), `services/transcript-usage.ts` (feed `/context`/`/cost`).
- **Client**: `hooks/useChat.ts` (new stream events), `components/Chat/` — new compaction divider, permission card in `ToolCallRow`/`ToolInputForm`, out-of-turn system entry in `MessageList`/`MessageContent`, sticky todo strip in `ChatPane`, refreshed slash allowlist in `ChatInput`/`ChatPane`.
- **DB**: one migration — per-topic `permission_prompts` flag; compaction / out-of-turn markers stored as `messages` rows with a distinguishing `role`/kind (no new table).
- **Tests**: `bun:test` on the pure additions (compaction event parser, control-protocol codec, slash router, out-of-turn classifier, tail-read cap); Playwright E2E on the UI flows (compaction divider appears + persists across reload, `/model` switches on claude-code, permission card allow/deny round-trip, Monitor completion renders inline).
