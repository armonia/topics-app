# Design: add-master-topic-mode

## Architectural decisions

### AD-1: Reuse existing PTY path (`terminal.ts` `type:'claude-code'`)

The current `claude-code.ts` provider spawns `claude --print --output-format stream-json`. That is **programmatic mode** (pool credit post-15-giugno).

We **do not** modify that provider. Instead we extend the existing `terminal.ts` route (which already spawns `claude` interactive in `node-pty`, no `--print`) to support a `type: 'claude-code-team'` variant that injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**Rationale:** interactive PTY path is sub-safe. Reusing it minimizes surface area and risk.

### AD-2: Shared task list as source of truth

Claude Code Agent Teams persists the team's task list at `~/.claude/projects/<project-hash>/tasks/*.json`. Topics file-watches this directory and mirrors into its own `tasks` table.

**Why mirror instead of read-through?** Existing kanban code reads from `tasks` table. Mirroring keeps existing read paths untouched and adds eventual consistency only on writes.

**Conflict resolution:** last-write-wins with `updated_at` comparison. UI warns if board-side edit collides with claude-side edit within 5s.

### AD-3: Topic ↔ task binding via DB columns

```sql
ALTER TABLE topics ADD COLUMN parent_topic_id TEXT REFERENCES topics(id);
ALTER TABLE topics ADD COLUMN agent_team_role TEXT CHECK(agent_team_role IN ('lead','teammate'));
ALTER TABLE topics ADD COLUMN claude_session_id TEXT;

ALTER TABLE tasks ADD COLUMN assigned_topic_id TEXT REFERENCES topics(id);
ALTER TABLE tasks ADD COLUMN claude_task_id TEXT UNIQUE;
```

All nullable. Existing topics/tasks unaffected.

### AD-4: Stream-json event store (events table)

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_task_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL, -- thinking|tool_use|tool_result|task_complete|task_failed
  payload TEXT NOT NULL, -- JSON
  FOREIGN KEY(topic_id) REFERENCES topics(id)
);
CREATE INDEX idx_task_events_task ON task_events(claude_task_id, ts);
```

Bounded retention: keep last 1000 events per task, prune older.

### AD-5: Notification triple-layer

Pattern adopted from `gmr/claude-status`:

1. **Real-time push (Darwin notifications)** — Claude Code hooks write to `~/.topics/events.jsonl` and post a `DistributedNotificationCenter` event. Topics tray app subscribes.
2. **FS watcher backup (chokidar)** — picks up missed writes if Darwin notif is throttled.
3. **5-second polling fallback** — guarantees eventual delivery.

Severity routing:
- **P0** (blocker, crash, awaiting permission) → sound + desktop notif + iOS push
- **P1** (task awaiting review) → silent desktop notif + tray badge
- **P2** (info, idle) → tray badge only

Focus mode awareness via `osascript` reads `~/Library/DoNotDisturb.plist` (or DND state) to suppress P1/P2 during quiet hours.

### AD-6: Claude Code hooks integration

Add to user's `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "command": "bun ~/Projects/topics-app/scripts/hook-stop.ts" }
    ],
    "PreToolUse": [
      { "command": "bun ~/Projects/topics-app/scripts/hook-pretooluse.ts" }
    ]
  }
}
```

Hook scripts read stdin (Claude Code passes JSON event), append to `~/.topics/events.jsonl`, post Darwin notif if severity ≥ P1.

**Non-invasive:** hooks only emit events; never block tool calls.

### AD-7: agent-conductor as workspace dep

Import `agent-conductor` from local path or git submodule. Use:
- `discover()` to find running `claude` processes across the system
- `deriveStatus()` for badge state
- `reminders` subpath for macOS Reminders bridge

Topics does **not** replace agent-conductor's CLI. Topics is a UI consumer of agent-conductor's library API.

### AD-8: Master CLI design

```bash
topics master --project ~/Projects/microgeo
# → creates topic with agent_team_role='lead', cwd=microgeo
# → spawns claude with AGENT_TEAMS=1
# → opens browser

topics master --resume <topic-id>
# → resumes existing master topic
```

CLI uses existing daemon socket (cli/topics.ts already has daemon-control infra). Adds one subcommand.

### AD-9: Token budget guardrail

When user attempts to spawn 4+ active teammates on a Claude Pro plan, UI shows:

> ⚠️ Pro weekly limit may be reached fast. Consider Max 5x or reducing parallel teammates.

Detection: read Claude Code login info from `~/.claude/auth.json` (best effort), assume Pro if unknown.

## Test strategy

- **Unit**: stream-json parser, severity classifier, conflict resolver
- **Integration**: spawn real `claude` with team flag in CI (skipped if CLI not present, with clear message)
- **Playwright (spec-flow)**: full user flow Master CLI → board → click → focus → review
- **Manual smoke checklist**: `tests/manual-smoke.md` for human verification

## Migration safety

All schema changes are additive (new columns nullable, new tables). Existing data untouched. Rollback = drop new columns/tables. Add migration script `migrations/2026-05-master-topic.sql`.

## Open questions

- Q1: Should "Awaiting Review" require explicit human approval before task moves to Done, or can Claude self-mark via shared task list? **Proposed:** default explicit human approval; setting toggle to allow auto-done.
- Q2: How to handle teammate cwd that's outside Topics' known projects? **Proposed:** create implicit project record for cwd; surface in projects sidebar.
- Q3: Should agent-conductor be vendored or git submodule? **Proposed:** workspace symlink in monorepo style for now.
