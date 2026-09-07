# The E2E suite on Windows

The product ships a Windows shell and has Windows users; the suite runs on Linux
in CI and on macOS on a laptop. This is how you run it on a real Windows box,
in ten lines, without adding a Windows job to `ci.yml`.

```bash
tools/topwin sync          # HEAD -> the PC (git archive over ssh), install, rebuild the bundle
tools/topwin e2e 1 4       # shard 1 of 4, JSON report written on the PC
tools/topwin pull          # tools/out/win/e2e-<shard>.json back here
```

Two shards at a time is the sane load: each one is a headless Chrome plus a Bun
server, and the same machine hosts other projects' benches. `tools/topwin load`
before you believe a red.

## The first run, 2026-09-07

Four shards on the Windows box, 1122 tests executed: **799 green, 323 red**, and
211 that never ran because the server died under them. Sorted by cause, because
the count that matters is the number of DEFECTS, not of red lines:

| Cause | Tests | What it is |
|---|---|---|
| Board id is the whole path | 76 | product, `projectIdForPath` splits on `/` only |
| Project boundary denies every child | ~48 | product, `isInsideKnownProject` compares with `base + "/"` |
| Server dies when the PTY bridge does not answer | 41 + 211 not run | product, an unhandled rejection takes the process down |
| No terminal opens | 20 | product, the PTY bridge fails its self-test |
| Cleanup refused by the filesystem | 18 | bench, fixed here (`removeTmpDir`) |
| The rest | ~120 | one at a time, unclassified |

Each product line has its own card; nothing was skipped to make the number look
better, and `check:test-skips` did not move.

What was in the way, and where the answer lives now:

- **`lsof`, `ps ax`, `kill -PID` do not exist there.** They are behind
  `tests/e2e/helpers/platform.ts` (`netstat -ano` keyed on the `0.0.0.0:0`
  remote address, not on the word LISTENING, which is translated on a localized
  Windows; `Get-CimInstance Win32_Process`; `taskkill /F`, always forced,
  because a plain `taskkill` posts a WM_CLOSE that a console process ignores).
- **The test server has two launchers.** `scripts/start-test-server.sh` on
  POSIX, `scripts/start-test-server.win.mjs` on Windows: bash eats the
  backslashes of a Windows `DATA_DIR`, so the server would put its database
  where the bench is not looking.
- **The scratch root is `os.tmpdir()` only on Windows** (`canonicalTmpRoot`).
  On macOS that call points at `/var/folders/...` and would move `DATA_DIR`
  away from the path everything else assumes.
- **The PTY bridge and the AI bridge are named pipes**, `\\.\pipe\<name>`, never
  `/tmp/*.sock`.
- **A spec path never starts with a literal `/tmp`.** On Windows that string
  resolves to `C:\tmp`, which the bench then creates at the root of the system
  drive, outside the isolation everything else agrees on. The spelling is
  `canonicalTmpDir("name")` / `canonicalTmpRoot()` from
  `tests/e2e/helpers/file-project.ts`, which is also what fixes the
  `/tmp` versus `/private/tmp` mismatch on macOS.
- **`rmSync` in a cleanup carries `maxRetries: 5, retryDelay: 100`.** Windows
  refuses to delete a directory while any process still holds a handle inside
  it, and the server closes its database a moment after the last test. Measured:
  18 spec files failed on `EPERM` in the cleanup, with every test in them green.
  On POSIX the retry never fires.
- **`bun` is not callable by name from `cmd` on that machine**: the system PATH
  carries an unpaired quote (`C:\Program Files\dotnet"`) that kills cmd's own
  resolution for every entry after it. Node's `spawn` splits PATH itself and is
  fine, which is why the harness calls `bun` by name and `tools/topwin` uses the
  absolute path.
