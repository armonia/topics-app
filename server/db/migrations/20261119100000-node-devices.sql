-- 20261119100000-node-devices.sql
--
-- The credential a Topics server collects by pairing this one as its node gets
-- a row here, and the gate lets it reach the fleet's routes and nothing else
-- (`lib/node-scope.ts`, card a97724c1). Before this table it was an owner's:
-- with it a paired server could run a command on the node and, from loopback,
-- approve a pairing that hands the node's channel over.
--
-- A table of its own and not `devices.role = 'node'`, for the reason the
-- screen table gives: runtime authorization never reads the legacy role column.
-- machine_id is the id the server declared at pairing, NULL when it declared
-- none (a secondary, or a credential from before the table). origin says how
-- the row got here: 'paired', 'migrated' (below) or 'learned' (the gate).
CREATE TABLE IF NOT EXISTS node_devices (
  device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  machine_id TEXT,
  created_at INTEGER NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'paired' CHECK (origin IN ('paired', 'migrated', 'learned'))
);

-- Which credential created each run (`/api/nodes/runs`), so that only it reads,
-- bundles and cancels it: a node credential is not a licence to touch every
-- card of this board. machine_id lets the same primary, paired again under a
-- new device row, keep the runs it started.
CREATE TABLE IF NOT EXISTS node_run_callers (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  machine_id TEXT,
  created_at INTEGER NOT NULL
);

-- The machine credentials already paired, ALL of them, from what this server
-- wrote and never from a header.
--
-- 1. The device holding the channel (recorded at pairing since 18/11).
INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at, origin)
  SELECT ps.channel_device_id, ps.channel_machine_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migrated'
    FROM primary_state ps
   WHERE ps.id = 1 AND ps.channel_device_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM devices d WHERE d.id = ps.channel_device_id);

-- 2. Every other one. Before 18/11 the channel was not recorded, so a node
-- paired then has none. What tells its machine credentials apart is the name
-- the server gave the device at pairing: `deviceNameFromUserAgent` names every
-- browser and phone by its platform, and gives a Topics server (whose user
-- agent is `Topics/<version> (<host>)` or Bun's own) the fallback label in the
-- literal below. A device carrying that label that ever showed a person's
-- hand (a push subscription, a chat message it wrote) is a person's and stays
-- owner; one a person renamed was renamed by a person. Screens stay screens.
INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at, origin)
  SELECT d.id, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migrated'
    FROM devices d
   WHERE d.revoked_at IS NULL
     AND d.name = 'Dispositivo sconosciuto' -- allow-italian: the exact label the server stored, matched as data
     AND NOT EXISTS (SELECT 1 FROM screen_devices s WHERE s.device_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.auth_device_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_device_id = d.id);
