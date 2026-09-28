/**
 * SERVER.TS HANDS THE TURN ROWS TO THE TESTED HELPERS, AND WRITES NONE ITSELF.
 * @covers CHAT-INT-01
 *
 * Card a57e6d4d: how a row was closed lives in `end_reason`, and the writers
 * outside the chat route are helpers with their own tests
 * (`closed-outside.ts`, `boot-orphan-tools.ts`, driven by
 * `mcp/cut-row-end-reason.test.ts` and `send-chat-boot-sweep.test.ts`).
 * server.ts cannot be imported by a test (importing it starts the server), so
 * the one thing left there, that it calls them, is read from its source, as
 * `swap-freeze.wiring.test.ts` does. Put back the base's inline SQL (a relight
 * of the session's last row, a close with no `end_reason`) and this goes red,
 * while every helper test stays green.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const server = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");

/** The source of the block that opens with `opener`, up to `closer`. */
function block(opener: string, closer: string): string {
  const from = server.indexOf(opener);
  expect(from, `\`${opener}\` is gone from server.ts`).toBeGreaterThan(-1);
  const to = server.indexOf(closer, from + opener.length);
  return server.slice(from, to < 0 ? undefined : to);
}

describe("server.ts closes and relights turn rows only through the helpers", () => {
  test("the end of a reattach leg is endReattachLeg, with the claude-code provider as the broker", () => {
    expect(block("async function reattachSurvivingChatTurns(", "\n}\n"))
      .toContain('.finally(() => endReattachLeg(ctx.db, s.id, tryGetProvider("claude-code")))');
  });

  test("the stale-stream sweeper closes a row through finalizeStaleRow", () => {
    expect(block("const staleStreamTimer = setInterval(", "\n}, ")).toContain("finalizeMessage: (args) => finalizeStaleRow(db, args)");
  });

  test("the orphan-tool cleanup runs after the boot's partial sweep, with the broker's live sessions", () => {
    const sweep = server.indexOf("runBootPartialSweep(db, {");
    const orphans = server.indexOf("finalizeOrphanedRunningTools(db, liveBrokerChatSessions);");
    expect([sweep > -1, orphans > -1]).toEqual([true, true]);
    // It reads the sweep's cut-by-restart to leave a cut row's content alone.
    expect(sweep).toBeLessThan(orphans);
  });

  test("no SQL in server.ts turns a message's partial flag on or off", () => {
    expect(server.match(/UPDATE messages SET[^"`]*\bpartial\s*=\s*[01]/g) ?? []).toEqual([]);
  });
});
