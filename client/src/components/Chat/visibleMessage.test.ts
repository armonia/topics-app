/**
 * A silent-reply marker hides itself, never the real work that came with it.
 *
 * @covers CHAT-02
 */
import { describe, expect, test } from "bun:test";
import { toVisibleMessage } from "./visibleMessage";

const msg = (o: Record<string, unknown>) => ({ id: "m", role: "assistant", content: "", ...o }) as never;

describe("toVisibleMessage", () => {
  test("a bare marker with no work is hidden", () => {
    expect(toVisibleMessage(msg({ content: "NO_REPLY" }))).toBeNull();
    expect(toVisibleMessage(msg({ content: "ANNOUNCE_SKIP" }))).toBeNull();
  });
  test("a marker on a turn that ran tools keeps the turn, without the marker", () => {
    const out = toVisibleMessage(msg({ content: "NO_REPLY", toolCalls: [{ id: "t" }] })) as { content: string };
    expect(out.content).toBe("");
  });
  test("prose ending with the marker keeps the prose", () => {
    const out = toVisibleMessage(msg({ content: "Done, it works.\n\nNO_REPLY" })) as { content: string };
    expect(out.content).toBe("Done, it works.");
  });
  test("ordinary and empty messages behave as before", () => {
    expect(toVisibleMessage(msg({ content: "hi" }))).not.toBeNull();
    expect(toVisibleMessage(msg({ content: "" }))).toBeNull();
    expect(toVisibleMessage(msg({ content: "Agent-to-agent announce step 1" }))).toBeNull();
  });
});
