-- 20261109002110-screen-devices.sql
--
-- A device paired as a SCREEN (the PC's monitor showing the load screen) gets a
-- row here, and the gate lets it read two routes and nothing else.
--
-- A table of its own and not `devices.role = 'screen'`: runtime authorization
-- never reads the legacy device role (GUEST-06), and a screen is not a role on
-- the owner/guest axis anyway, it is a narrower thing than a guest.
-- ON DELETE CASCADE: a device row that goes takes its screen mark with it.
CREATE TABLE IF NOT EXISTS screen_devices (
  device_id  TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
