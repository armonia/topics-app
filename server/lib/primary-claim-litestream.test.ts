/**
 * @covers MACHINE-07
 *
 * The claim of a dead primary's place from its REAL replica (track T9): a real
 * `litestream replicate` with an age-encrypted `file://` replica, killed with
 * SIGKILL while the DB is being written, then the real `claimPrimary` with a
 * real `litestream restore`. Skipped unless Litestream 0.3.x (the last line
 * with age encryption) and `age-keygen` are in PATH. The longer measure, with
 * the seconds lost, is `bun scripts/probe-claim-loss.ts`.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { measureClaimLoss } from "../../scripts/probe-claim-loss";

const litestream = Bun.which("litestream");
const ageCapable = !!litestream && !!Bun.which("age-keygen")
  && /^v0\.3\./.test(spawnSync(litestream, ["version"], { encoding: "utf-8" }).stdout.trim());

describe.skipIf(!ageCapable)("primary claim from a real Litestream replica", () => {
  test("restores the encrypted replica of a primary killed mid-write, losing at most the last seconds", async () => {
    const m = await measureClaimLoss({ seconds: 3 });
    expect(m.report).toMatchObject({ ok: true, outcome: "claimed", epoch: 2 });
    expect(m.replicaInClear).toBe(false);
    expect(m.restoredRows).toBeGreaterThan(0);
    expect(m.restoredRows).toBeLessThanOrEqual(m.writtenRows);
    // Litestream syncs every second: what is lost is the last interval, never minutes.
    expect(m.lostSeconds).not.toBeNull();
    expect(m.lostSeconds!).toBeLessThan(5);
  }, 60_000);
});
