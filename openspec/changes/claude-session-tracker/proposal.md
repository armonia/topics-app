# Change: claude-session-tracker

## Why

A Claude Code session running inside a Topics App terminal pane has a rich lifecycle — starting, running, calling tools, awaiting user input, awaiting permission approval, idle, paused, completed, dormant (resumable), errored. Today the app only sees **two of those states**:

1. `terminal_sessions.status` — PTY is `active` or `dormant`. Tells us if the process is alive, nothing about what it's doing.
2. `agent_sessions.status` — derived from a heartbeat (last write <30s) + the in-memory `activeStreams` map. Misclassifies "blocked on approval" as `active` because the PTY still receives bytes.

Real lifecycle signals exist but are scraped from PTY stdout — fragile, breaks when Claude's TUI rendering changes, and several signals (approval requested, tool starting) are practically invisible.

Claude Code exposes two **first-party, structured** sources we are not using:

- **JSONL transcript** at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — append-only, one event per line (`user`, `assistant`, `tool_use`, `tool_result`, `summary`). Authoritative, survives crashes, supports recovery via byte offset.
- **Settings hooks** (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`) — push events from the running CLI, delivered as a script invocation that can POST to our server.

This change makes Topics App treat Claude Code sessions as first-class state machines driven by those two sources.

## What changes

1. **`ClaudeSession` model** — server-authoritative record with a canonical `phase` enum and metadata (resumable, pending approval, last tool, JSONL offset).
2. **JSONL tailer** — generalises the existing `SubagentPoll` parser into `ClaudeSessionTracker`: tail-follow each known JSONL, persist byte offset, emit phase transitions.
3. **Hook endpoint** — `POST /api/claude-hooks/:event` accepts the JSON payload Claude Code's hook scripts produce on stdin. Authenticated by a per-install secret token.
4. **Hook installer** — `scripts/install-claude-hooks.sh` writes the eight hook scripts into `~/.claude/settings.json` (merging with existing user hooks, never overwriting). Idempotent.
5. **WS broadcast `session:state`** — single canonical event whenever a `ClaudeSession` transitions. Replaces ad-hoc derivation in `useTabNotifications` / `useCompletionNotifier` over time (this change keeps the legacy events alive in parallel; client cutover is a follow-up).
6. **Stale phase reaper** — cron sweep that demotes stuck phases: `tool-running` older than 10 min with no `PostToolUse` → `running`; `awaiting-approval` older than 10 min → `paused`; PTY exit without `SessionEnd` → `error`.
7. **Recovery on boot** — at server start, for every `claude_code_sessions` row that points at an existing JSONL, replay from `jsonl_offset` to rebuild `phase`. Hooks then take over for live transitions.

## Out of scope

- Replacing existing `agent_sessions.status` (kept in parallel; deprecation is a future change once all consumers read `ClaudeSession`).
- Client UI redesign for the new phases (badge color rules, toast routing). This change ships a minimal `useClaudeSessionState` hook + WS subscription; production UI rewiring is a follow-up.
- Multi-machine session sync (Topics App today is single-host; hooks bind to localhost).

## Risks

- **Hook delivery is best-effort.** Claude Code's hook scripts run in the user's shell environment; if curl is missing or the server is down, the event is dropped. Mitigated by JSONL replay on boot and the stale-phase reaper.
- **JSONL format drift.** Anthropic does change the event shape periodically. The parser degrades gracefully: unknown event types advance the offset but leave `phase` untouched.
- **Hook auth token.** A leaked token lets any local process spoof session state. Token is stored in `~/.claude/topics-hook-token` with `chmod 600`, generated once on install, never sent over the wire by Topics. Threat model: local-only; users with shell access already have full control of the app.
- **Hook script footprint.** Eight tiny POSIX shell wrappers in `~/.claude/topics-hooks/`. Installer is opt-in (user runs it once) and shows a diff of `settings.json` before applying.

## Impact

- **Specs added**: `claude-sessions/`
- **Specs modified (delta)**: `terminal/` (link to new spec for the lifecycle-tracking section).
- **DB migration**: `027-claude-session-tracker.sql` extends `claude_code_sessions` with `phase`, `phase_updated_at`, `jsonl_path`, `jsonl_offset`, `pending_approval_json`, `last_tool_json`, `last_hook_at`, `rev`. All nullable / defaulted; no breaking changes to existing rows.
- **Code areas**: new `server/lib/claude-session-tracker.ts`, new `server/routes/claude-hooks.ts`, registration in `server.ts`, new `scripts/claude-hooks/` directory + installer, new `client/src/hooks/useClaudeSessionState.ts`, type additions in `client/src/types/index.ts`.
- **Tests**: `server/lib/claude-session-tracker.test.ts` (pure derivation, dedup, offset advancement), Playwright E2E for hook → WS → UI roundtrip (follow-up).

## Estimate

~3 dev-days end-to-end. Phasing:
- **Phase 1**: DB + tracker lib + unit tests (1d)
- **Phase 2**: Hook endpoint + installer + WS broadcast (1d)
- **Phase 3**: Client hook + minimal integration + docs (1d)
