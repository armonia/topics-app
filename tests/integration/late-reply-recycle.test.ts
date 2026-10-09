/**
 * A RETRY MUST NOT RECYCLE A SOCKET A LATE REPLY STILL RIDES ON.
 *
 * An `attachWhole` scan past its cap waits for its late ack on this socket
 * (`lateReplies`). A concurrent `list` that sees the daemon mute for its ack
 * timeout retries, and `request` used to drop the socket before retrying:
 * `failWaiters` resolved every late reply with null, and the scan failed
 * although the daemon was alive and about to answer.
 *
 * Each case runs in a child `bun test`. The caps are module constants read at
 * import, so shrinking them in this process would either do nothing (another
 * file imported the client first) or leak a 300 ms cap to every file after.
 *
 * @covers CCLI-04
 */
import { expect, test } from "bun:test";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

function runCase(name: string): void {
  const env: Record<string, string | undefined> = { ...process.env };
  // A fresh child: no data folder inherited from whatever ran before in this process.
  delete env.DATA_DIR;
  delete env.TOPICS_DATA_DIR;
  env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS = "300";
  env.TOPICS_AI_BRIDGE_MAX_ACK_MS = "300";
  env.TOPICS_AI_BRIDGE_STALL_TICK_MS = "25";
  env.TOPICS_AI_BRIDGE_ACK_MS = "300";
  env.LATE_RECYCLE_CASE = name;
  const run = Bun.spawnSync([process.execPath, "test", "./tests/integration/late-reply-recycle.scenario.ts"], {
    cwd: ROOT, env, stdout: "pipe", stderr: "pipe",
  });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(run.exitCode, out.slice(-4000)).toBe(0);
}

test("a scan past the cap, with a concurrent list that goes mute: both get their answers", () => runCase("with-list"), 300_000);
test("control: no concurrent list, the late ack lands", () => runCase("no-list"), 300_000);
