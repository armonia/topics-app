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
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "stray-fixture-"));
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
  for (let i = 0; i < 200 && !existsSync(socket); i++) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
});

afterAll(() => {
  if (process.env.STRAY_FIXTURE_STOP === "1" && pid) process.kill(pid, "SIGTERM");
});
