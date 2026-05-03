## ADDED Requirements

### Requirement: DAEMON-01 — Singleton lock + state file

At startup the server SHALL acquire a singleton lock at `~/.topics/daemon-process.lock` and write its connection details to `~/.topics/daemon-state.json` atomically. Both files live under `TOPICS_HOME` (default `~/.topics`).

#### Scenario: Acquire lock on a fresh start
- **GIVEN** no other server instance is running
- **WHEN** `server.ts` boots
- **THEN** the system SHALL create `~/.topics/daemon-process.lock` containing `{ pid, acquiredAt }`
- **AND** write `~/.topics/daemon-state.json` (mode 0600) containing `{ pid, port, token, startedAt }`
- **AND** the token SHALL be 32 random bytes encoded as hex
- **AND** state files SHALL be atomically renamed from `<file>.tmp` so a crashed write never leaves a half-file

#### Scenario: Reject a second start while a live process holds the lock
- **GIVEN** a server is already running with pid P, lock file present
- **WHEN** another `server.ts` boot attempts to acquire the lock
- **AND** `process.kill(P, 0)` succeeds (the process is alive)
- **THEN** the boot SHALL exit with code 1 and a clear error naming P
- **AND** SHALL not overwrite the existing state file

#### Scenario: Recover from a stale lock left by a crashed process
- **GIVEN** a `daemon-process.lock` exists for pid P
- **WHEN** a fresh boot attempts to acquire the lock
- **AND** `process.kill(P, 0)` throws ESRCH (the process is gone)
- **THEN** the system SHALL log a structured "stale lock recovered" line
- **AND** SHALL overwrite the lock with the new pid
- **AND** SHALL proceed with normal startup

#### Scenario: Release lock on graceful shutdown
- **GIVEN** the server is running
- **WHEN** SIGINT or SIGTERM is delivered
- **THEN** the system SHALL delete `~/.topics/daemon-process.lock`
- **AND** SHALL delete `~/.topics/daemon-state.json`
- **AND** SHALL close the database, then exit

### Requirement: DAEMON-02 — Token-authed loopback control endpoints

The server SHALL expose two control endpoints at the existing `Bun.serve` listener under the `/__daemon/` path prefix. Both require a `Authorization: Bearer <token>` header matching the token in `daemon-state.json`. Endpoints SHALL bind only on `127.0.0.1` requests (the listener already binds 0.0.0.0; the bearer-token check is the security boundary).

#### Scenario: Healthz returns runtime metadata
- **WHEN** a client `GET /__daemon/healthz` with the correct bearer token
- **THEN** the system SHALL respond 200 with body `{ pid, startedAt, uptime_ms }`

#### Scenario: Healthz rejects missing or wrong token
- **WHEN** a client `GET /__daemon/healthz` without an `Authorization` header
- **THEN** the system SHALL respond 401 with body `{ error: 'unauthorized' }`
- **AND** the same response SHALL fire when the bearer token does not match the state file

#### Scenario: Shutdown triggers graceful exit
- **WHEN** a client `POST /__daemon/shutdown` with the correct bearer token
- **THEN** the system SHALL respond 202 immediately
- **AND** SHALL fire SIGTERM on the current process within 100 ms
- **AND** the existing graceful-shutdown handler SHALL run (db close, bridge disconnect, lock release)

#### Scenario: Other clients on the same machine cannot guess the token
- **GIVEN** the token is 32 random bytes (256 bits)
- **WHEN** an unauthorized process attempts to call `/__daemon/shutdown` with a guessed token
- **THEN** even at 1M attempts/sec the expected time to a successful guess is > 10^60 years

### Requirement: DAEMON-03 — Electron LaunchAgent management (macOS)

When the user opts in via the Settings card, the Electron app SHALL install a LaunchAgent plist at `~/Library/LaunchAgents/com.armonia.topics-daemon.plist` that runs the server at login under launchd supervision. Toggling off SHALL cleanly remove the plist and bootout the agent.

#### Scenario: Install LaunchAgent
- **GIVEN** the user toggles "On at login" in Settings
- **WHEN** the IPC `daemon:install-launchagent` handler runs
- **THEN** it SHALL write the plist with `RunAtLoad: true`, `KeepAlive: { SuccessfulExit: false, Crashed: true }`, `ThrottleInterval: 5`, stdout/stderr to `~/.topics/logs/daemon.log`
- **AND** SHALL run `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/com.armonia.topics-daemon.plist` via `execFileSync` (never a shell string)
- **AND** SHALL respond `{ ok: true, status: 'running' }` on success

#### Scenario: Uninstall LaunchAgent
- **GIVEN** the LaunchAgent plist is currently installed
- **WHEN** the user toggles "On at login" off
- **THEN** the system SHALL run `launchctl bootout gui/<uid>/com.armonia.topics-daemon` then delete the plist
- **AND** the daemon process SHALL keep running until its next graceful exit; the toggle does not kill it

#### Scenario: Status reports lifecycle correctly
- **WHEN** the IPC `daemon:status` handler runs
- **THEN** it SHALL read `daemon-state.json` and call `GET /__daemon/healthz` with the token
- **AND** SHALL respond `{ running, pid?, uptimeMs?, launchAgentInstalled }` based on the union of evidence
- **AND** absent state file → `running: false, launchAgentInstalled: <fs.existsSync(plist)>`
