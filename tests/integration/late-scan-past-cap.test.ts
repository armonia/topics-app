/**
 * CCLI-04 - a re-adoption past the ai-bridge ack cap gets the whole turn: every attach behind the
 * store's backlog waits for its late ack (`attachWhole`) instead of failing at the cap. The scan, the
 * boot probe whose scan becomes it, the rewind of a turn still open, the rewind of a turn that ended
 * while detached, and the tail fetch of a CLI that exited while the backlog drained, during which the
 * route's watchdog still reads the turn alive.
 *
 * Each case runs in a child `bun test`. The caps are module constants read at import, so shrinking
 * them in this process would either do nothing (another file imported the client first) or leave a
 * 300 ms cap to every file after this one.
 *
 * @covers CCLI-04
 */
import { expect, test } from "bun:test";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

function runCase(name: string, scenario = "late-scan-past-cap"): void {
  const env: Record<string, string | undefined> = { ...process.env };
  // A fresh child: no data folder inherited from whatever ran before in this process.
  delete env.DATA_DIR;
  delete env.TOPICS_DATA_DIR;
  env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS = "300";
  env.TOPICS_AI_BRIDGE_MAX_ACK_MS = "300";
  env.TOPICS_AI_BRIDGE_STALL_TICK_MS = "25";
  env.LATE_SCAN_CASE = name;
  const run = Bun.spawnSync([process.execPath, "test", `./tests/integration/${scenario}.scenario.ts`], {
    cwd: ROOT, env, stdout: "pipe", stderr: "pipe",
  });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(run.exitCode, out.slice(-4000)).toBe(0);
}

test("a turn still open behind a 20 MB store replay, past the cap: it arrives whole into its row", () => runCase("open"), 300_000);
test("a turn that ended while detached, rewound past the cap: it arrives whole into its row", () => runCase("completed"), 300_000);
test("a CLI that exits while the backlog drains: its tail is fetched past the cap, the row is whole", () => runCase("exit"), 300_000);
test("at boot, the probe of a session with no partial row sees its turn open behind the replay, past the cap", () => runCase("probe", "late-scan-boot"), 300_000);
test("a CLI that exits while another session's backlog drains: the route waits for its tail, the row is whole", () => runCase("exit-grace", "late-scan-boot"), 300_000);
