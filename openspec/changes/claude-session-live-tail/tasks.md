# Tasks: claude-session-live-tail

## Phase 1 — Pure derivation (claude-session-state.ts)

- [x] 1.1 `parseJsonlLine`: extract `timestamp` (ISO → epoch ms) into the returned event; classify meta/local-command/compact/interrupt user lines as new `meta` kind (ignored by applyJsonlEvent).
- [x] 1.2 `applyJsonlEvent`: accept `eventTime`; causal gate (phase-advancing event older than `phaseUpdatedAt` → no-op); `assistant` promotes any non-terminal phase to `running`; `user` (wake-qualifying) unchanged-but-gated.
- [x] 1.3 `deriveTranscriptPath(cwd, claudeSessionId)` helper with Claude Code's dir encoding (non-alphanumeric → `-`).

## Phase 2 — Tracker (claude-session-tracker.ts)

- [x] 2.1 Extract shared `tailSessionFile(state)` from `recoverFromJsonl` (read tail from offset, apply lines with per-line eventTime, persist/commit + broadcast).
- [x] 2.2 `tailOnce()` sweeping DB `listActive()` + in-memory terminal states (non-terminal phases); `startJsonlTail(intervalMs = 1500)` with unref'd interval.
- [x] 2.3 `registerTerminalSession(csid, { cwd })`: derive jsonlPath; snap offset to file size when the file already exists.
- [x] 2.4 Offset snap when a hook CHANGES `jsonlPath` (SessionStart with a new path) — same-path re-fires keep the persisted offset.

## Phase 3 — Wire-up

- [x] 3.1 `server/routes/terminal.ts`: pass `cwd` at all three `registerTerminalSession` call sites.
- [x] 3.2 `server.ts`: `claudeSessionTracker.startJsonlTail()` after boot recovery.

## Phase 4 — Tests

- [x] 4.1 Unit: timestamp extraction; meta/local-command/compact/interrupt classification (real-shape fixtures); wake user line and task-notification → `running`.
- [x] 4.2 Unit: causal gate (older-than-phase lines skipped; newer applied; missing timestamp applies ungated).
- [x] 4.3 Unit: assistant-from-resting promotion; terminal phases never revived.
- [x] 4.4 Integration (temp dir): tailOnce on a growing file — offset advance, partial-line carry, broadcast on transition; registration snap against pre-existing file; in-memory terminal session tailed via derived path.

## Phase 5 — Verification

- [x] 5.1 `tsc -b` green, full `bun test` green.
- [x] 5.2 Apply to prod (`launchctl kickstart -k gui/$(id -u)/com.armonia.topics-server`), verify app alive.
- [x] 5.3 Live check: parked claude-code session + injected task-notification → spinner+aura within ~2 s, banner on re-park.
