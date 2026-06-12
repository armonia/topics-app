# Computer-use permissions (macOS TCC) for Topics-spawned Claude

## The problem

A Claude session inside Topics that tries "computer use" (screen capture,
mouse/keyboard control via `screencapture` / `cliclick` / `osascript`) is
silently denied by macOS. It is **not** Claude Code's own permission system —
Topics already bypasses that (`--permission-mode bypassPermissions` for the chat
provider, `--dangerously-skip-permissions` for interactive PTYs). It is **macOS
TCC** (Screen Recording / Accessibility / Automation).

TCC does not authorize the process that calls the tool; it walks up to the
**responsible process** and validates *its* code signature. The Claude sessions
are spawned by the **bun server**, which runs under the `com.armonia.topics-server`
LaunchAgent as `/bin/bash scripts/start-prod.sh` — i.e. a launchd job with **no
stable, code-signed responsible app**. So a Screen-Recording / Accessibility
grant has nothing to attach to, and the attribution chain resolves to NULL →
default deny. (Verified live: the bun server spawns `claude` as a child for chat
topics; for terminals it goes through the detached `pty-bridge.mjs` which
reparents to launchd — see the caveat below.)

Sources: the responsible-process model
(<https://mjtsai.com/blog/2025/07/07/the-curious-case-of-the-responsible-process/>),
Apple's `AssociatedBundleIdentifiers` / SMAppService anchoring, and the
near-identical OpenClaw #14138 (`screencapture` under a launchd agent → TCC
blocks even with a full binary path).

## The fix — a signed host app + `AssociatedBundleIdentifiers`

Put a tiny, **code-signed** Mach-O launcher (`Topics Host.app`, bundle id
`io.armonia.topics.host`) at the root of the server job and tell launchd to
attribute the whole job tree to that bundle. Then `bun → claude → zsh →
screencapture` all inherit `Topics Host` as the responsible code, and a one-time
grant to "Topics Host" sticks (the signature is stable across repo edits /
hot-reload — only this ~30-line wrapper is signed/frozen).

- `scripts/topics-host/topics-host.c` — the launcher. `posix_spawn`s
  `/bin/bash start-prod.sh` and waits, so it stays alive as the responsible-code
  anchor. Forwards SIGTERM/SIGINT to the process group on stop.
- `scripts/build-topics-host.sh` — compiles + signs + installs
  `~/Applications/Topics Host.app` (auto-detects a team-signed identity).
- `scripts/apply-topics-host-plist.sh` — patches the installed
  `com.armonia.topics-server.plist` (ProgramArguments → the host, plus
  `AssociatedBundleIdentifiers`), with a timestamped backup. Does **not** restart.

## Status (already done autonomously)

- [x] Built + signed `~/Applications/Topics Host.app`
      (`Apple Distribution: HWYL srl (WCQ2LX8T39)`, Team `WCQ2LX8T39`, bundle id
      `io.armonia.topics.host`; `codesign --verify --strict` passes).
- [x] Launcher mechanics smoke-tested (spawn + wait + exit-code propagation).
- [x] Staged the plist patch on the installed agent (backup created). **Not
      restarted** — the running server + its live sessions are untouched.

## Finish (3 steps — yours, because they restart the app / touch System Settings)

1. **Apply the new launch config** (restarts the server agent → kills the
   running server + its live sessions, so pick a good moment):

   ```bash
   launchctl bootout gui/$(id -u)/com.armonia.topics-server 2>/dev/null
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.armonia.topics-server.plist
   ```

2. **Grant TCC to "Topics Host"** — System Settings → Privacy & Security:
   - **Screen Recording** → add / enable **Topics Host**
   - **Accessibility** → add / enable **Topics Host**
   - **Automation** → approve when first prompted (per target app)

   (If "Topics Host" isn't listed, click `+` and pick
   `~/Applications/Topics Host.app`.)

3. **Verify** the grant actually reaches Claude (needs sudo):

   ```bash
   CLAUDE_PID=$(pgrep -n -f 'claude')
   sudo launchctl procinfo "$CLAUDE_PID" | grep -i responsible
   ```

   It must show **Topics Host** (not `pid 1` / `(null)`). Then run a
   computer-use command from a Topics Claude session — it should succeed.

## Caveat — interactive PTY terminals (detached bridge)

Chat-topic Claude sessions are non-detached children of the server, so they are
covered by the fix. **Interactive terminal** Claude sessions are spawned through
`server/pty-bridge.mjs`, which is `spawn(..., { detached: true })` + `unref()`
(`server/routes/terminal.ts`) and reparents to launchd (PPID 1) — escaping the
job tree. `AssociatedBundleIdentifiers` may not reach it. If terminal-session
computer-use is also needed, the follow-up is to either keep the bridge a child
of the server (drop `detached`, which trades off the bridge's survive-server-
reload durability) or give the bridge its own association. Chat-path computer-use
is the common case and is what this fix targets.

## Note on the signing identity

The only local codesigning identity is **Apple Distribution** (Team `WCQ2LX8T39`),
not **Developer ID Application**. For a locally-built, locally-run daily-driver
this is fine — TCC keys on the stable team signature + bundle id, and the grant
persists as long as the app is re-signed with the same identity/id. (Developer ID
would additionally satisfy Gatekeeper for *distributed* copies; not relevant for
this local launcher.) Re-running `build-topics-host.sh` re-signs with the same
identity, so the grant survives rebuilds.

## Rollback

```bash
# restore the previous plist (timestamp from apply output) and re-bootstrap
cp ~/Library/LaunchAgents/com.armonia.topics-server.plist.bak.* \
   ~/Library/LaunchAgents/com.armonia.topics-server.plist
launchctl bootout gui/$(id -u)/com.armonia.topics-server 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.armonia.topics-server.plist
```
