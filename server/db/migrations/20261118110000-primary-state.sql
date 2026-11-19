-- Which computer is the primary and in which epoch (card 688f4013). One row.
-- primary_machine_id is the primary's machines.id; NULL means nobody was ever chosen,
-- so this install is its own primary (the single-computer case). The epoch only goes up.
-- channel_* is the primary that paired this server as a node: its device row here and
-- the machine id it declared at pairing. Only a request authenticated as that device
-- may carry a higher epoch in, and the id it names is this one, never a header.
CREATE TABLE IF NOT EXISTS primary_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_machine_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 0,
  since TEXT,
  channel_device_id TEXT,
  channel_machine_id TEXT
);
INSERT OR IGNORE INTO primary_state (id, primary_machine_id, epoch, since) VALUES (1, NULL, 0, NULL);
