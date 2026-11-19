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
-- none (a secondary, or a credential learned at runtime).
-- legacy_driver marks, on a node with no channel yet, the one machine
-- credential the migration found driving it: with no channel, only that device
-- (or the only node credential there is) may start runs (`mayDriveRuns`).
CREATE TABLE IF NOT EXISTS node_devices (
  device_id     TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  machine_id    TEXT,
  created_at    INTEGER NOT NULL,
  legacy_driver INTEGER NOT NULL DEFAULT 0
);

-- The node credential that asked for a run (POST /api/nodes/runs): only it reads,
-- fetches or cancels the run. NULL = a run from before the field, or from a person.
ALTER TABLE tasks ADD COLUMN node_run_device TEXT;

-- The machine credential holding the channel.
INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at)
  SELECT ps.channel_device_id, ps.channel_machine_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM primary_state ps
   WHERE ps.id = 1 AND ps.channel_device_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM devices d WHERE d.id = ps.channel_device_id);

-- Every other machine credential already paired. Nothing at pairing recorded
-- "this is a server", except the name the server wrote for it: the label
-- `deviceNameFromUserAgent` gives a user agent naming no platform, which is what
-- every Topics server has sent its nodes since node pairing exists
-- (`Topics/<version> (<host>)`). A phone or a browser always names one (iPhone,
-- Android, Mac, Windows, Linux). A device a person uses also leaves traces a
-- server never does: a push subscription, a message it wrote; either keeps it
-- owner. A person who lands here by mistake pairs again.
INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at)
  SELECT d.id, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM devices d
   WHERE d.name = 'Dispositivo sconosciuto'
     AND NOT EXISTS (SELECT 1 FROM screen_devices s WHERE s.device_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.auth_device_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_device_id = d.id);

-- No channel: the machine credential seen last is the primary that drives this
-- node today (it calls the node every few seconds); the others are stale cookies
-- of the same machine or secondaries, and start no runs.
UPDATE node_devices SET legacy_driver = 1
 WHERE NOT EXISTS (SELECT 1 FROM primary_state ps WHERE ps.id = 1 AND ps.channel_device_id IS NOT NULL)
   AND device_id = (
     SELECT d.id FROM devices d JOIN node_devices n ON n.device_id = d.id
      WHERE d.revoked_at IS NULL
      ORDER BY COALESCE(d.last_seen_at, d.created_at) DESC LIMIT 1);
