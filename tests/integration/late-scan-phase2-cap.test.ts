/**
 * CCLI-04 - a re-adoption past the ai-bridge ack cap gets the whole open turn: the scan AND the rewind
 * after it wait for their late ack (`attachWhole`), instead of the rewind failing at the cap.
 *
 * The scenario runs in a child `bun test`. The caps are module constants read at import, so shrinking
 * them in this process would either do nothing (another file imported the client first) or leave a
 * 300 ms cap to every file after this one.
 *
 * @covers CCLI-04
 */
import { expect, test } from "bun:test";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

test("a rewind behind a 20 MB store replay, past the cap: the open turn arrives whole into its row", () => {
  const env: Record<string, string | undefined> = { ...process.env };
  // A fresh child: no data folder inherited from whatever ran before in this process.
  delete env.DATA_DIR;
  delete env.TOPICS_DATA_DIR;
  env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS = "300";
  env.TOPICS_AI_BRIDGE_MAX_ACK_MS = "300";
  env.TOPICS_AI_BRIDGE_STALL_TICK_MS = "25";
  const run = Bun.spawnSync([process.execPath, "test", "./tests/integration/late-scan-phase2-cap.scenario.ts"], {
    cwd: ROOT, env, stdout: "pipe", stderr: "pipe",
  });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(run.exitCode, out.slice(-4000)).toBe(0);
}, 300_000);
