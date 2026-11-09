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
  expect(line).toContain("activeStreams.size");
  expect(line).toContain("countBusyAgentTerminals()");
});
