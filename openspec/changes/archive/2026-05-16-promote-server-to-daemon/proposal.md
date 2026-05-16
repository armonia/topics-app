# Promote the Bun server to a Daemon (Phase B)

## Why

Today the Topics Bun server is foreground-only: it dies when the terminal that started it exits, and there is no canonical way to keep it alive across user sessions or across Electron-window close events. Phase A introduced a Project + Worktree domain whose value is highest when an agent can keep running while the user closes the laptop lid; that requires a process the OS supervises, not a manual `bun run server.ts`.

This change promotes the existing server to a "daemon mode" without rewriting it. The same `server.ts` entry point gains a singleton lock, a control state file, token-authed loopback control endpoints, and an Electron-side LaunchAgent installer. Behaviour for users running it manually is unchanged.

## What Changes

- **Singleton lock at `~/.topics/daemon-process.lock`** — `{pid, acquiredAt}` with stale-pid detection via `process.kill(pid, 0)`. Two simultaneous starts are rejected fast with a clear error pointing at the existing pid.
- **State file `~/.topics/daemon-state.json`** — `{pid, port, token, startedAt}` written atomically (`.tmp` + rename) at startup. Mode 0600. Token is 32 random bytes hex. State file is the canonical answer for "is the daemon running and how do I talk to it" — Electron reads it instead of pinging port 3333 blindly.
- **Token-authed control endpoints** at the existing `Bun.serve` listener (no second port):
  - `GET /__daemon/healthz` → 200 with `{pid, startedAt, uptime_ms}`.
  - `POST /__daemon/shutdown` → graceful exit (calls the existing SIGINT handler).
  - Bearer token from the state file is required; absent or wrong → 401.
- **Topics directory bootstrap**: `~/.topics/{daemon-state.json,daemon-process.lock}` created with `mkdirSync(recursive)` on first run.
- **LaunchAgent plist** at `~/Library/LaunchAgents/com.armonia.topics-daemon.plist`:
  - Generated from a template inside `electron-app/main.ts`.
  - `RunAtLoad` true, `KeepAlive { SuccessfulExit: false, Crashed: true }`, `ThrottleInterval: 5`.
  - Stdout/stderr to `~/.topics/logs/daemon.log`.
  - Honours an `EnableLaunchAgent` electron-store toggle so the user opts in.
- **Electron IPC** (all using `execFileSync`/`execFile`, never shell-string forms):
  - `daemon:install-launchagent` → write plist + `launchctl bootstrap`.
  - `daemon:uninstall-launchagent` → `launchctl bootout` + delete plist.
  - `daemon:status` → reads `~/.topics/daemon-state.json` and `GET /__daemon/healthz` with the token.
- **Settings UI card**: "Background mode" with three states — *Off*, *On (this session)*, *On at login (LaunchAgent)*. Shows pid + uptime when running.

## Capabilities

### New Capabilities

- `daemon` — singleton-locked, OS-supervised long-running server with token-authed loopback control plane.

### Modified Capabilities

- `system-status` — gains a daemon section with pid, uptime, and LaunchAgent status.

## Impact

**Server:**
- `server/services/daemon-state.ts` (new) — `acquireLock`, `releaseLock`, `writeState`, `readState`, `isStaleLock`.
- `server.ts` — bootstrap call to acquireLock + writeState before `Bun.serve`. Add `/__daemon/*` route handler with bearer-token check. Hook SIGINT to releaseLock.
- `~/.topics/` directory becomes the canonical state location (env override `TOPICS_HOME`).

**Electron app:**
- `electron-app/main.ts` — IPC handlers + plist template + `execFileSync(["launchctl", …])`.
- `electron-app/preload.ts` — expose `daemon.install/uninstall/status`.

**Client:**
- `client/src/components/Settings/BackgroundModeCard.tsx` (new) — three-state toggle.
- `client/src/lib/electronApi.ts` (or wherever `window.electronAPI` is typed) — add `daemon` namespace.

**Tests:**
- `tests/integration/daemon-lifecycle.test.ts` — singleton lock + atomic state write + stale-pid recovery + bearer-token control endpoints.
- `tests/e2e/background-mode.spec.ts` — Settings card states + LaunchAgent install round-trip (skipped on non-mac CI).

**Out of scope:**
- Auto-rotating the control token. The token is regenerated on every fresh start; rotation while running is a Phase B+1 enhancement if needed.
- Cloud relay. Topics keeps the local daemon as the pivot.
- Token-authed mutual auth between Electron and daemon — bearer token is one-way (Electron knows the token, daemon trusts it).

**Backward-compat:**
- `bun run dev:server` continues to work exactly as today.
- The state file + lock are written even in non-daemon mode; concurrent dev-server runs that try to bind 3333 still hit Bun's port-already-in-use error first.
- Electron app keeps the existing in-process server-launch path (`scripts/start-electron-prod.sh`) when the LaunchAgent is off.
