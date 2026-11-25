/**
 * A RE-ADOPTION STILL RUNNING READS «ALIVE» TO THE ROUTE'S WATCHDOG, EVEN IF ITS CHILD IS GONE.
 *
 * A child that exits after the scan has folded its whole store has nothing past our cursor: `closeAfterTail`
 * closes it at once (`alive` false, no `exitTail`). The rewind that closes the row can still wait behind another
 * session's backlog, longer than the route's soft + grace windows, and a «dead» answer there finalized the row as
 * a timeout with its answer already in the store (main CI, 16/11, `late-scan-boot` exit-grace).
 *
 * @covers CCLI-04
 */
import { expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";

function provider(pp: Record<string, unknown>) {
  const p = new ClaudeCodeProvider({ type: "claude-code" });
  (p as any).processes.set("topic:readopt", { sessionKey: "topic:readopt", streamHandler: null, ...pp });
  return p;
}

test("a gone child with its re-adoption in flight is alive to the watchdog, and dead once it is over", () => {
  expect(provider({ alive: false, readopting: true }).isTurnProcessAlive("topic:readopt")).toBe(true);
  expect(provider({ alive: false, readopting: false }).isTurnProcessAlive("topic:readopt")).toBe(false);
  expect(provider({ alive: false }).isTurnProcessAlive("topic:readopt")).toBe(false);
});
