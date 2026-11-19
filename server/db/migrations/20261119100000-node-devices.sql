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
CREATE TABLE IF NOT EXISTS node_devices (
  device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  machine_id TEXT,
  created_at INTEGER NOT NULL
);

-- The machine credentials already paired: the one holding the channel is the
-- only one this database can name. The others are marked by the gate the first
-- time they call the node's run routes as a Topics server (`shouldLearnNodeDevice`).
INSERT OR IGNORE INTO node_devices (device_id, machine_id, created_at)
  SELECT ps.channel_device_id, ps.channel_machine_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM primary_state ps
   WHERE ps.id = 1 AND ps.channel_device_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM devices d WHERE d.id = ps.channel_device_id);
