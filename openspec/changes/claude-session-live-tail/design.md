# Design: claude-session-live-tail

## Context

Ground truth from real transcripts (`~/.claude/projects/<enc>/<sid>.jsonl`, sampled 2026-07-12):

| line kind | discriminators | phase meaning |
|---|---|---|
| real user prompt | `type:'user'`, string content, `promptSource:'typed'`, `origin.kind:'human'` | new turn → `running` |
| **task-notification (Monitor/background wake)** | `type:'user'`, `promptSource:'system'`, `origin.kind:'task-notification'`, content `<task-notification>…` | new turn → `running` |
| local command echo | content starts `<command-name>` / `<local-command-…`, some `isMeta:true` | NOT a turn — ignore |
| meta lines | `isMeta:true` ("Stop hook active…", caveat) | ignore |
| compact summary | `isCompactSummary:true` | ignore |
| interrupt | content `[Request interrupted…` | ignore |
| tool_result (user-role) | first content block `type:'tool_result'` | `tool-running` → `running` (existing) |
| assistant | `type:'assistant'`, `timestamp` per line, written incrementally during the turn | model producing output → `running` |
| tool_use (in assistant) | content block `type:'tool_use'` | → `tool-running` (existing) |

Every user/assistant line carries an ISO `timestamp`. `isSidechain` was 0 across 3350 sampled lines (subagent transcripts live in separate files) — sidechain lines, if ever present, are ignored for phase.

Encoding of the project dir: every char outside `[A-Za-z0-9]` → `-` (verified: `/Users/zorahrel/.claude/jarvis` → `-Users-zorahrel--claude-jarvis`).

## Decisions

### D1 — Poll-stat tail, not fs.watch
One sweep every `JSONL_TAIL_INTERVAL_MS = 1500` over all live sessions: `stat(jsonlPath)`; if `size > jsonlOffset`, read `[offset, size)`, split complete lines (existing `splitJsonlChunk`), apply, persist new offset. A handful of `stat()`s per tick is negligible; polling avoids FSEvents coalescing/rename edge cases and bounds staleness at ~1.5 s — well under the human threshold for "the spinner reacted".

Sessions swept: `repo.listActive()` (non-terminal-phase DB rows, as boot recovery does) ∪ in-memory `terminalStates` whose phase is non-terminal. Read errors leave the session untouched (same tolerance as boot recovery).

### D2 — Causal gate: line timestamp vs phaseUpdatedAt
`applyJsonlEvent` gains the event's wall-clock time (`eventTime`, parsed from the line's `timestamp`; `undefined` when absent). A **phase-advancing** event with `eventTime < prev.phaseUpdatedAt` returns `prev` unchanged: the hook stream has already produced a newer authoritative phase.

Why: hooks are push (ms latency), the tail is pull (≤1.5 s latency). Without the gate the classic race is: assistant line written at T1 → `Stop` hook at T2 parks the session → tail reads the T1 line at T2+ε and wrongly revives to `running`, which then needs the 10-minute reaper to undo. With the gate, stale lines are no-ops while genuinely new events (wake at T3 > T2) pass.

Lines with no timestamp apply ungated — identical to today's boot replay for legacy shapes.

### D3 — Wake classifier is exclusion-based
`parseJsonlLine` classifies a `type:'user'` line as `user` (wake-capable) only if none of: `isMeta`, `isCompactSummary`, content starting with `<command-name>`/`<local-command`/`[Request interrupted`, tool_result content block (that path already exists). Everything else that is genuinely user-role — typed prompts, task-notifications, teammate messages, future injected-turn flavors — defaults to wake. Erring toward "show work" is the right failure mode: a false `running` is corrected by `Stop`/reaper; a hidden working session is the bug this change exists to fix.

New classification `meta` (ignored by `applyJsonlEvent`) so the intent is explicit in the parser's output rather than silently mapped to `other`.

### D4 — `applyJsonlEvent` transitions (delta)
- `user` (wake-qualifying): any non-terminal phase → `running`, clears `pendingApproval`. (Today: same, but the new classifier + gate make it safe to keep unconditional.)
- `assistant`: any non-terminal phase → `running` (today only `tool-running` → `running`). An assistant line is the model literally producing output; from `awaiting-user`/`paused`/`dormant`/`starting` it means a turn is in flight whose opening user line we may have gated or missed.
- `tool_use` / `tool_result` / `summary` / `other`: unchanged.
- Terminal phases (`completed`/`error`): never revived by JSONL (unchanged guard).

### D5 — jsonlPath derivation + offset snap
`registerTerminalSession(claudeSessionId, opts?: { cwd?: string })`:
- Derives `jsonlPath = ~/.claude/projects/<encode(cwd)>/<claudeSessionId>.jsonl` when `cwd` is known (all three call sites in terminal.ts have it).
- If the file already exists at registration (a `--resume`, a server restart re-registering a live session), `jsonlOffset` snaps to the current file size: the tail consumes only lines written **after** tracking started. No history replay, no phase time-travel.
- If the file doesn't exist yet (fresh spawn — Claude creates it on first event), offset 0; the whole file is a few lines when it appears.

Same snap on the hook path: when a `SessionStart` hook **changes** `jsonlPath` (previously unset or different), the tracker stats the new file and snaps the offset. A re-fired `SessionStart` with the same path leaves the persisted offset alone (boot-recovery contract intact).

### D6 — No client changes
The fix is upstream. `RESTING_CLAUDE_PHASES` suppression, `terminalRingFrom` strictness, notifier transition-diffing all stay as designed — they were correct rules reading a lying input. After this change the woken turn is `running` within ≤1.5 s (spinner + aura + rollup light up), and its `Stop` → `awaiting-user` is a real transition again (banner fires, new `rev`).

## Failure modes considered

- **Wake line for a turn that produces no output** (e.g. notification consumed silently): phase `running` until `Stop` (hooked sessions — instant) or reaper demotion on pty silence (hook-less, 10 min). Acceptable and bounded; strictly better than hiding real work.
- **Huge burst append** (compact rewrite, `--resume` fork): reads are offset-bounded; a pathological multi-MB append is read once, parsed line-by-line, and the causal gate discards stale lines. Compact rewrites a NEW file only on fork (new session id → new registration → snap).
- **File truncated/rotated** (size < offset): treated as no-growth; a `SessionStart` hook with the new path re-snaps. (Claude Code appends-only in practice.)
- **Two sessions same transcript** (impossible by construction — path embeds the session id).
