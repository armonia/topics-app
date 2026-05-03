# Multi-Machine (Phase D)

## Why

A topic is currently anchored to one host implicitly — whichever machine the daemon happens to be running on. The reference desktop client treats *machines* as first-class so users can see "this topic was started on my MacBook, that one on my desktop tower." Phase D persists the concept and adds the heartbeat plumbing; UI for switching across machines stays minimal in this phase (an inline filter + a list view), with the deeper "All Machines" surface deferred to a UX-heavy phase.

## What Changes

- **Migration 020 — `CREATE TABLE machines`**:
  ```
  id TEXT PRIMARY KEY,                     -- UUID per host
  name TEXT NOT NULL,                      -- display, default = hostname
  hostname TEXT NOT NULL,                  -- os.hostname()
  arch TEXT NOT NULL,                      -- process.arch
  platform TEXT NOT NULL,                  -- process.platform
  daemon_version TEXT NOT NULL,            -- package.json version
  status TEXT NOT NULL DEFAULT 'online'    -- online | offline (UI hint)
    CHECK(status IN ('online','offline')),
  last_heartbeat_at TEXT NOT NULL,         -- ISO
  last_seen_at TEXT NOT NULL,              -- ISO
  acknowledged_warnings TEXT,              -- JSON map { reason → ISO }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  ```
  + index on `last_heartbeat_at` for the cleanup query.
- **Migration 021 — `ALTER TABLE topics ADD COLUMN machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL`**. Additive only; legacy topics see NULL = "wherever the local daemon runs."
- **`MachineStore`** service (pure SQL): `upsertLocal()` reads `os.hostname/arch/platform` + the package version and writes/updates the local row with a fresh `last_heartbeat_at`. Called every 30 s by a new background ticker.
- **`HeartbeatTicker`** in `server.ts` startup: every 30 s call `MachineStore.upsertLocal()`; flag any other machine whose `last_heartbeat_at` is older than 5 min as `offline`. Broadcasts `machine:updated`.
- **REST routes** `/api/machines`:
  - `GET /api/machines` → list (sorted by `last_heartbeat_at` desc)
  - `GET /api/machines/:id` → single
  - `PATCH /api/machines/:id` → rename (display name only)
  - `DELETE /api/machines/:id` → only if no topics reference it
- **WebSocket broadcasts** `machine:upserted | machine:updated | machine:deleted` (`payload_version: 1`).
- **Client**: `Machine` interface + `useMachines` hook (mirroring useProjects/useWorktrees). `App.tsx` doesn't yet expose the filter pill — that's a future UX phase — but the data is available.

## Capabilities

### New Capabilities

- `machines` — first-class machine entity with heartbeat-driven status and a per-host UUID.

### Modified Capabilities

- `topics` — gains optional `machineId` FK (NULL = legacy).

## Impact

Server: 2 migrations, 1 store, 1 routes file, 1 ticker hook in `server.ts`. ~250 LOC.
Client: 1 type + 1 API namespace + 1 hook. ~120 LOC.
Tests: integration suite covering upsertLocal idempotence, FK SET NULL on machine delete, REST validation.

**Out of scope:**
- "Switch to machine X" UX. The filter pill in the dashboard surface lands later — Phase D ships only data + REST.
- Per-topic execution targeting (running an agent on a specific machine). The `topics.machine_id` field is informational in this phase; the daemon doesn't yet route work based on it.
- Machine pairing / approval. The local machine is auto-created the first time the heartbeat ticks; remote machines (if any) come from the same backend the WS gateway already uses, which Topics doesn't expose yet.

**Backward-compat:** every change is additive. Topics with `machine_id = NULL` continue to behave exactly as today.
