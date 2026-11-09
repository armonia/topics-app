# Hub service, track R3: reads for the tray and the bridge

Outcome note for the card. The code lives in the private jarvis repo (branch `topics/r3-letture`,
`tools/usage-hub/rust/hub-service`), not here.

- Endpoints served by the Rust service: machines, board, mac, mac/trust, mac/procs, automations/summary,
  alerts, forecast, services, pc, project-settings (GET and POST), backup-mac.
- `golden-diff` against the live hub: 9 of the 10 listed endpoints identical. The remaining difference is
  `automations/summary` `sources[].at`, null for GitHub and the PC until their first background read has run.
- Safe process close: `POST /api/mac/procs/close {pid, started}` plus `GET /api/mac/procs/start?pid=`. A reused
  pid is refused, SIGTERM comes before SIGKILL, system processes and other users are refused (cargo tests on
  fake processes).
- Footprint with the census and the other reads active: peak 3 MB resident (limit 60 MB), transient node
  reader not included.
- Heavy computation stays in `bin/hub-read.mjs`, called on demand and cached 30 to 120 seconds, the last copy
  served while a new read runs behind.
- No live service was touched.

Code branch commits: 7efe4d8b, d256d289 (jarvis repo).
Branch also carries a one-line spec id fix (KANBAN-109).
CI note: the PTY sidecar kill test is unrelated to this change.
