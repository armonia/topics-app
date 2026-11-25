/**
 * A test file that starts a real ai-bridge daemon the way a careless test
 * would: detached, on a socket of its own, and nothing ever stopping it.
 * `STRAY_FIXTURE_STOP=1` makes it clean up after itself.
 *
 * Run only by `stray-ai-bridges.test.ts`, through the real suite runner. Its
 * name keeps it out of the suite: bun discovers `*.test.ts`, not this.
 */
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { slackMs } from "../tests/helpers/time-slack";

// Short base on purpose: under the runner this file already runs inside two
// nested private TMPDIR levels, and a socket under tmpdir() grows past the
// macOS 104 character unix socket limit so the daemon never listens.
const shortBase = "/tmp/topics-test";
mkdirSync(shortBase, { recursive: true });
const dir = mkdtempSync(join(shortBase, "stray-fixture-"));
const socket = join(dir, "ai-bridge.sock");
let pid = 0;

test("starts a daemon", async () => {
  const daemon = spawn(
    process.execPath,
    [join(import.meta.dir, "..", "server", "ai-bridge.mjs"), "--socket", socket, "--store-dir", join(dir, "store")],
    // The runner's marker reaches the daemon the only way it ever does: the
    // environment it is spawned with.
    { detached: true, stdio: "ignore", env: { ...process.env } },
  );
  daemon.unref();
  pid = daemon.pid ?? 0;
  // The daemon takes seconds to listen on a loaded machine (10 s fixed was missed at load 25 on 12 cores).
  const deadline = Date.now() + slackMs(10_000);
  while (Date.now() < deadline && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
}, slackMs(30_000));

afterAll(() => {
  if (process.env.STRAY_FIXTURE_STOP === "1" && pid) process.kill(pid, "SIGTERM");
  // This file's own scratch: leaving it behind marks the file red under the
  // runner's per-file TMPDIR check. Stray detection reads the daemon from
  // `ps`, not from this directory, so removing it hides nothing.
  rmSync(dir, { recursive: true, force: true });
});
