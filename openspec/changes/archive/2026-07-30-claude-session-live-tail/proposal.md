# Change: claude-session-live-tail

## Why

The phase machine (claude-session-tracker) is fed by two sources today: **hooks** (live) and **JSONL replay** (boot-only, DB-backed topic sessions only — the live tailer was deferred in the original change, task 2.4). This leaves a structural blind spot:

**A parked session woken by a background event is invisible.** When a session sits at `awaiting-user` and a Monitor fires, a background task completes, a teammate sends a message, or a cron injects a prompt, Claude starts a new turn — but no hook announces it (`UserPromptSubmit` fires only for human prompt submissions; the first `PreToolUse` arrives only if/when the turn calls a tool, and a text-only turn never fires anything until `Stop`). Because `awaiting-user` is a RESTING phase, the client deliberately suppresses the pty-busy fallback for it. Net effect, exactly as reported:

- no loading spinner, no working aura, no project rollup, no status-bar count while the woken turn runs;
- no "in attesa di te" banner when the turn re-parks (`Stop` → `awaiting-user` is a same-phase no-op, so `session:state` never fires and the notifier's transition diff sees nothing).

The authoritative signal already exists on disk: the session's JSONL transcript records the injected wake-up as a `user` line (`origin.kind = 'task-notification'`) and every assistant/tool event of the turn, each with a wall-clock `timestamp`. The tracker even has the pure functions to consume it (`applyJsonlEvent`, `splitJsonlChunk`, persisted `jsonlOffset`) — they just never run after boot, and never for terminal (in-memory) sessions.

A second, smaller consequence: the terminal working aura is deliberately stricter than the spinner (phase-active only). Any session whose hooks are silent (pinned at `starting`) shows a spinner but never an aura. With the phase machine made reliable by live tailing, the two indicators converge without touching the client rules.

## What changes

1. **Live JSONL tail loop** in `claude-session-tracker`: a periodic sweep (default 1.5 s) that `stat()`s each live session's transcript and, on growth, reads the new tail from the persisted offset and applies each event — the same code path as boot recovery, now continuous and covering **both** DB-backed topic sessions and in-memory terminal sessions.
2. **Causal gate on JSONL events**: each line's `timestamp` is compared to the session's `phaseUpdatedAt`; an event older than the last authoritative phase change is skipped. This kills the race where the tail reads an `assistant` line written just before a `Stop` hook already parked the session (blind replay would wrongly revive it).
3. **Wake-capable transitions** in `applyJsonlEvent`: a qualifying `user` line (real prompt, task-notification, teammate message — NOT meta/local-command/compact-summary/interrupt lines) moves any non-terminal phase to `running`; an `assistant` line now also promotes from resting phases (today it only promotes `tool-running` → `running`).
4. **jsonlPath derivation for terminal sessions**: `registerTerminalSession` learns the session's `cwd` and derives the canonical transcript path (`~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl`) instead of waiting for a `SessionStart` hook that may never fire. On first sighting of an existing file the offset snaps to the current size (only future lines matter — no multi-MB history replay, no phase clobbering from stale lines).
5. **No client changes to the signal rules.** Spinner (`terminalLoadingFrom`), aura (`terminalRingFrom`, strict phase-active), rollups, status bar and the banner notifier all read the phase — once the phase is honest, they align by construction.

## Out of scope

- A "has active monitors/background tasks while parked" indicator (watching-state). Weak signals, separate UX question.
- The sustained-pty-busy aura fallback for transcript-less sessions — sessions spawned by Topics always know their cwd, so the derived path covers them; bare sessions Topics merely observes are shells (pty-driven aura already).
- `fs.watch`-based tailing. Polling `stat()` at 1.5 s across the handful of live sessions is ~free, has no macOS FSEvents edge cases, and bounds staleness explicitly.

## Risks

- **JSONL format drift**: already tolerated — unknown line shapes map to `other` (offset advances, phase untouched). The wake classifier is exclusion-based (meta/local-command/compact/interrupt filtered out), so a new injected-turn flavor defaults to "wake", which errs toward showing work rather than hiding it.
- **Clock skew between hook arrival time and transcript timestamps**: both are wall-clock on the same machine; the gate compares like-for-like within milliseconds of skew. Events with no timestamp (legacy lines) apply ungated, preserving today's boot-replay behavior.
- **False `running` from a wake line whose turn produces nothing**: bounded by the existing reaper — `running` with a silent PTY demotes to `dormant` after `runningTimeoutMs`; a `Stop` hook or the turn's own JSONL lines correct it sooner.

## Impact

- **Specs modified (delta)**: `claude-sessions/` — CCS-03 extended (JSONL as live co-driver with causal ordering), new CCS-07 (live tail requirement).
- **Code areas**: `server/lib/claude-session-state.ts` (timestamp extraction, wake classifier, resting→running transitions), `server/lib/claude-session-tracker.ts` (tail loop, offset snap, terminal-session coverage), `server/routes/terminal.ts` (pass `cwd` at registration), `server.ts` (start the tail loop).
- **DB**: none — `jsonl_path` / `jsonl_offset` columns already exist.
- **Tests**: `bun:test` on the pure additions + tracker tail integration on temp files.
