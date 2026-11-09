/**
 * The automatic land waits for ZERO open turns before it reloads the live
 * server. "Open turns" must be the server's own count: chat streams plus the
 * agent terminals mid-turn (`status.ts`, the presence counts). Counting only
 * `activeStreams` lands a reload under a terminal agent that is working.
 *
 * @covers LAND-05
 */
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("server.ts hands the auto-lander the server's whole turn count", () => {
  const src = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
  const line = src.split("\n").find((l) => l.includes("liveTurnCount:"));
  expect(line).toBeDefined();
  expect(line).toContain("autoLandTurnCount");
  const at = src.indexOf("async function autoLandTurnCount");
  expect(at).toBeGreaterThan(0);
  const body = src.slice(at, at + 900);
  // The restart gate's own predicate (cards and lands in flight, broker turns, parked questions)...
  expect(body).toContain("whatIsStillWorking()");
  // ...and the streams and busy agent terminals the first version counted.
  expect(body).toContain("activeStreams.size");
  expect(body).toContain("countBusyAgentTerminals()");
});

test("server.ts reads the delivery's paths from the exact commit's net diff, not from the own-commit walk or the branch tip", () => {
  const src = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
  const at = src.indexOf("deliveryFiles: async");
  expect(at).toBeGreaterThan(0);
  const body = src.slice(at, src.indexOf("liveTurnCount:", at));
  // The commit the land will merge is the second argument, and it is what git is asked about.
  expect(body).toContain("(taskId, commit)");
  expect(body).toContain("landingFiles(ref.repoPath, commit)");
  // `ownBranchFiles` leaves out the pruning-residue commit the merge carries.
  expect(body).not.toContain("ownBranchFiles");
});
