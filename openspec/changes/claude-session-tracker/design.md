# Design: claude-session-tracker

## Phase state machine

```
              ┌─────────────┐
              │   (none)    │
              └──────┬──────┘
                     │ SessionStart hook OR new claude_code_sessions row
                     ▼
              ┌─────────────┐         user closes window / PTY exits with code 0
   ┌──────────│  starting   │──────────────────────────────────────────┐
   │          └──────┬──────┘                                          │
   │                 │ first UserPromptSubmit                          │
   │                 ▼                                                 ▼
   │          ┌─────────────┐    PreToolUse        ┌─────────────┐   ┌───────────┐
   │  ┌───────│   running   │─────────────────────►│tool-running │   │ completed │
   │  │       └──────┬──────┘                       └──────┬──────┘   └───────────┘
   │  │              │ Stop hook                          │ PostToolUse        ▲
   │  │              ▼                                    ▼                    │
   │  │       ┌──────────────┐    UserPromptSubmit   ┌──────────┐               │
   │  │       │awaiting-user │◄──────────────────────│ running  │──── SessionEnd
   │  │       └──────┬───────┘                       └──────────┘
   │  │              │ UserPromptSubmit
   │  │              └──────────────► running
   │  │
   │  │       ┌──────────────────┐
   │  └──────►│awaiting-approval │ (Notification hook with permission_request)
   │  ▲      └──────┬───────────┘
   │  │             │ next UserPromptSubmit / PostToolUse / Stop
   │  │             ▼
   │  └────────── running / awaiting-user
   │
   │   ┌─────────┐         resume API
   │   │ paused  │◄──────────────────── any non-terminal phase, manual pause
   │   └────┬────┘         PTY recreated with --resume
   │        ▼
   │  starting
   │
   │   ┌─────────┐         server boot finds claude_code_sessions row
   │   │ dormant │◄──────── whose PTY is gone but claudeSessionId is resumable
   │   └─────────┘
   │
   ▼
┌───────┐  PTY exit ≠ 0 without SessionEnd, OR reaper trips on stuck phase
│ error │
└───────┘
```

Phase is **monotonic on `rev`**: every transition bumps a per-session counter. Clients dedup by `(sessionKey, rev)`. The DB column `rev` is the authority for ordering.

## Data model

```sql
-- migration 027 extends claude_code_sessions
ALTER TABLE claude_code_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'dormant';
ALTER TABLE claude_code_sessions ADD COLUMN phase_updated_at TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN jsonl_path TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN jsonl_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claude_code_sessions ADD COLUMN pending_approval_json TEXT;  -- null when no approval pending
ALTER TABLE claude_code_sessions ADD COLUMN last_tool_json TEXT;          -- null between tool calls
ALTER TABLE claude_code_sessions ADD COLUMN last_hook_at TEXT;
ALTER TABLE claude_code_sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claude_code_sessions ADD COLUMN error_json TEXT;              -- {code,message,failedAt} when phase='error'

CREATE INDEX IF NOT EXISTS idx_claude_code_sessions_phase ON claude_code_sessions(phase);
```

Valid `phase` values (enforced in TypeScript, not as SQL CHECK to allow forward-compat):
`starting | running | tool-running | awaiting-user | awaiting-approval | paused | completed | error | dormant`.

## TypeScript surface

```ts
export type ClaudeSessionPhase =
  | 'starting'
  | 'running'
  | 'tool-running'
  | 'awaiting-user'
  | 'awaiting-approval'
  | 'paused'
  | 'completed'
  | 'error'
  | 'dormant';

export interface PendingApproval {
  kind: 'plan' | 'edit' | 'bash' | 'other';
  prompt: string;
  requestedAt: number;
}

export interface ActiveTool {
  name: string;
  input?: unknown;
  startedAt: number;
}

export interface ClaudeSession {
  sessionKey: string;
  claudeSessionId: string;
  phase: ClaudeSessionPhase;
  phaseUpdatedAt: number;
  jsonlPath?: string;
  jsonlOffset: number;
  pendingApproval?: PendingApproval;
  lastTool?: ActiveTool;
  lastHookAt?: number;
  rev: number;
  error?: { code: string; message: string; failedAt: number };
  // joined from claude_code_sessions row:
  createdAt: number;
  updatedAt: number;
}
```

## Hook payloads

Claude Code hooks invoke a script with a JSON object on stdin. The shared shape:

```json
{
  "hook_event_name": "Stop",
  "session_id": "01HXXXX...",
  "transcript_path": "/Users/.../.claude/projects/.../<id>.jsonl",
  "cwd": "/Users/.../topics-app",
  ...event-specific fields...
}
```

Our wrapper script POSTs the full payload to:

```
POST http://127.0.0.1:3333/api/claude-hooks/:hook_event_name
Authorization: Bearer <token from ~/.claude/topics-hook-token>
Content-Type: application/json
```

Response is ignored by the script. Exit code is always 0 (a failing hook should never block Claude). Timeout 2s.

### Event → transition mapping

| `hook_event_name` | Pre-condition | New phase | Side effect |
|-------------------|---------------|-----------|-------------|
| `SessionStart` | row missing | `starting` | insert row, set `jsonl_path` |
| `SessionStart` | row exists | `starting` | bump rev, reset offset to current EOF |
| `UserPromptSubmit` | any | `running` | clear `pendingApproval` |
| `PreToolUse` | `running` / `awaiting-approval` | `tool-running` | set `lastTool` |
| `PostToolUse` | `tool-running` | `running` | clear `lastTool` |
| `Notification` with `permission_request` | any active | `awaiting-approval` | set `pendingApproval` |
| `Notification` other | no change | n/a | update `lastHookAt` only |
| `Stop` | any active | `awaiting-user` | n/a |
| `SubagentStop` | any | no change | recorded but does not alter parent phase |
| `SessionEnd` | any | `completed` | n/a |

All transitions: bump `rev`, set `phase_updated_at`, set `last_hook_at`, broadcast WS.

### Source resolution: `session_id` → `sessionKey`

Topics App's `sessionKey` is its own identifier; Claude's `session_id` is the CLI UUID. The link lives in `claude_code_sessions.claude_session_id`. Lookup:

1. Direct match: `SELECT session_key FROM claude_code_sessions WHERE claude_session_id = ?`.
2. If no row exists, the hook arrived before our DB knew about the session. Insert a placeholder row (`session_key = NULL`, `phase = 'starting'`) keyed by `claude_session_id`; the terminal `createSession` path reconciles it when it next sets `claudeSessionId`.

Placeholder reconciliation is the only path that handles "user started `claude` from the CLI manually, not from a Topics pane" — those sessions appear in the tracker but have no UI surface until the user explicitly attaches.

## JSONL tailer

Reuses the parsing approach of `topics.ts`'s `SubagentPoll`. Differences:

- **One watcher per `jsonl_path`**, not per poll request.
- **Persistent offset** in `claude_code_sessions.jsonl_offset`.
- **Debounced** writes (max once per 250ms per session).
- **Newline-safe** read: only parse up to the last `\n`; remainder stays in buffer until the next read.

The tailer runs as a background `setInterval(scan, 1000)` plus an `fs.watch` per file for immediate wakeups. It is purely a **fallback / recovery** mechanism — the hook stream is the live path. The tailer only triggers a phase change if it sees an event the hooks missed (rare; primarily during recovery after a server restart).

## WS broadcast

```ts
{
  type: 'session:state',
  sessionKey: string,
  state: ClaudeSession,
}
```

Emitted from `claudeSessionTracker.update(...)`. Coalesced: if multiple transitions land in <50ms (e.g. SessionStart immediately followed by UserPromptSubmit), only the latest is broadcast. The DB writes are not coalesced.

## Reaper

A `setInterval(reap, 30_000)` sweep that:

1. Demotes `tool-running` rows where `last_hook_at` (or `phase_updated_at` if no hook ever fired) is older than 10 min → `running`, with `last_tool` cleared.
2. Demotes `awaiting-approval` older than 10 min → `paused`.
3. Detects `starting` rows whose JSONL has no events older than 5 min → `error` with `code='start-timeout'`.
4. Detects PTY exit non-zero without subsequent `SessionEnd` → `error` with `code='pty-crashed'` (hooked off the existing `bridge` exit signal in `server/routes/terminal.ts`).

Reaper transitions also bump `rev` and broadcast.

## Recovery on boot

At server start, after DB migrations:

1. `SELECT * FROM claude_code_sessions WHERE phase NOT IN ('completed', 'error', 'dormant')`.
2. For each row with a `jsonl_path` that exists on disk:
   - If `jsonl_offset` < file size, replay from offset, applying each event to derive `phase`.
   - Persist new offset and phase.
3. Rows whose PTY is gone (no entry in `sessions` map after `terminal.ts` finishes its own recovery) are demoted to `dormant` if `claude_session_id` is set, else `error`.

This guarantees the tracker is consistent within ~2s of server boot, regardless of how the previous process exited.

## Security

- **Token generation**: `openssl rand -hex 32` on first install, written to `~/.claude/topics-hook-token` (mode 0600) and to `~/.claude/topics-app/hook-token` (mode 0600) used by the server to validate.
- **Bind**: `/api/claude-hooks/*` only accepts connections from `127.0.0.1` (server-side check on `request.headers.get('host')` + remote address). Topics App already binds to localhost in dev; the production LaunchAgent matches.
- **CSRF**: not relevant — hooks are not browser-initiated.
- **Rate limit**: 50 events/sec per `claude_session_id`. Above that, drop with 429 logged. Real bursts top out around 10/sec during tool streams.

## Testing

- **Unit (`bun:test`)** — `claude-session-tracker.test.ts` covers:
  - Phase derivation from JSONL events (golden fixtures: a short run with one tool call, one approval, one error).
  - Hook payload → transition table.
  - Dedup by `(claude_session_id, hook_event_name, timestamp)` within a 100ms window.
  - Offset advancement: a partial last line is not committed.
  - Reaper conditions.
- **Integration** — a Bun script that fires sample hook payloads at the running server and asserts WS broadcasts arrive in order with monotonic `rev`.
- **E2E** — Playwright test that opens a Claude Code terminal pane, observes `session:state` events through the page's WS, and asserts phases transition as expected. (Deferred to follow-up; needs a stub `claude` binary in CI.)

## Migration & rollout

1. Migration `027-claude-session-tracker.sql` is additive; existing rows are migrated with `phase='dormant'` and `rev=0`. No data loss possible.
2. Hooks are opt-in: the installer is a separate script the user runs (`bun run hooks:install`). Without it, the system still works — only the live push channel is missing, and the JSONL tailer + recovery cover the gap with up to 1s latency.
3. Old WS events (`agent:session-status`, `unread:updated`) remain in place. Client consumers migrate one at a time in a follow-up change.
