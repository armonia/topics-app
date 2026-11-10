# Always-on service, track R2: pace, route, gate

The code lives in the separate service repo (card 895ff2f8), not here. This note records what was delivered.

- Ported to the Rust service with the same rules: `/api/gate`, `/api/gates`, `/api/override`, `/api/hold`,
  `/api/exhausted`, `/api/queue` (GET, POST, DELETE), `/api/heavy`, `/api/feedback` (POST).
  `/api/pace`, `/api/route` and `/api/attesa` were already there.
- `/api/overview`, `/api/live`, feedback reads and the vote "change" action are forwarded to an upstream URL;
  if it is down, the service answers with empty data, so callers are never blocked.
- Proof: golden bench 63/63 against the JS implementation (25 new cases, including write-then-read sequences);
  mutating the pace limit turns two cases red. Live read-only run: same shape as the old hub on 8 endpoints, 8-13 MB RSS.
- No live service was touched (ports and launchd are for the later cutover tracks).
