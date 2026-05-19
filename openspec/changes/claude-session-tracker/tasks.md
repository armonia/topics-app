# Tasks: claude-session-tracker

## Phase 1 — Schema + tracker library

- [ ] 1.1 Migration `027-claude-session-tracker.sql` extending `claude_code_sessions`.
- [ ] 1.2 `server/lib/claude-session-tracker.ts` — pure derivation (`applyHook`, `applyJsonlEvent`, `reapStaleSession`) + repo (`upsertSession`, `loadSession`, `listActiveSessions`).
- [ ] 1.3 `server/lib/claude-session-tracker.test.ts` (`bun:test`) covering all transitions, dedup, offset advancement, reaper.

## Phase 2 — Server wire-up

- [ ] 2.1 `server/routes/claude-hooks.ts` exposing `POST /api/claude-hooks/:event`, token auth, localhost guard, rate-limit (50/s per claude_session_id).
- [ ] 2.2 Register route in `server.ts`. Add token bootstrap (`server/lib/claude-hook-token.ts`): read or create `~/.claude/topics-app/hook-token` on startup.
- [ ] 2.3 WS broadcast helper: emit `{type:'session:state', sessionKey, state}` on every transition. Coalesce <50ms bursts.
- [ ] 2.4 JSONL tailer service: `fs.watch` + 1s scan, debounced 250ms per session, advances `jsonl_offset`.
- [ ] 2.5 Reaper: `setInterval(30_000)` sweep applying the four demotion rules from `design.md`.
- [ ] 2.6 Recovery on boot: replay JSONL from `jsonl_offset` for every non-terminal session, before tailer/reaper start.

## Phase 3 — Hook scripts + installer

- [ ] 3.1 `scripts/claude-hooks/post-hook.sh` — POSIX shell wrapper that reads stdin, reads token, curls server. Exit 0 always.
- [ ] 3.2 `scripts/install-claude-hooks.sh` — idempotent installer: writes scripts to `~/.claude/topics-hooks/`, merges into `~/.claude/settings.json` under `hooks.*` arrays.
- [ ] 3.3 `scripts/uninstall-claude-hooks.sh` — symmetric removal.
- [ ] 3.4 `bun run hooks:install` / `hooks:uninstall` aliases in root `package.json`.
- [ ] 3.5 README section "Claude Code hook integration" documenting install + threat model.

## Phase 4 — Client minimal integration

- [ ] 4.1 `client/src/types/index.ts` — add `ClaudeSession`, `ClaudeSessionPhase` types matching server.
- [ ] 4.2 `client/src/hooks/useClaudeSessionState.ts` — subscribes to WS `session:state`, exposes `Map<sessionKey, ClaudeSession>` + targeted accessors. Initial population via `GET /api/claude-sessions`.
- [ ] 4.3 `GET /api/claude-sessions` endpoint returning current `ClaudeSession[]`.
- [ ] 4.4 Wire `useClaudeSessionState` into `App.tsx` as a passive subscription (no UI consumer yet — that's the next change).

## Phase 5 — Verification

- [ ] 5.1 All unit tests pass: `bun test server/lib/claude-session-tracker.test.ts`.
- [ ] 5.2 Manual smoke: install hooks, start a Claude Code pane, post-prompt → see phase `running` → `awaiting-user` in `GET /api/claude-sessions`.
- [ ] 5.3 Kill server mid-stream, restart, verify phase recovers from JSONL replay.
- [ ] 5.4 Spec validation: `openspec validate claude-session-tracker --strict` passes.
