/**
 * THE TURN LEDGER, THROUGH THE REAL REGISTRY: every open and close of a turn is
 * said to every window, and a turn's end touches that turn only.
 * @covers CHAT-QUEUE-07
 *
 * `startStream`/`endStream` of `createAppContext` feed the ledger
 * (`server/lib/turn-ledger.ts`), and each transition goes out as `turn:state`:
 * that frame is what the turn queue of every window drains on.
 *
 * The second half is the ownership of the registry entry. A message parked
 * behind the CLI's own turn has its stream registered, and the adoption of the
 * CLI's turn registers its own row on the same session. `startStream` used to
 * overwrite the first entry and `endStream(sessionKey)` deleted whatever was
 * there: when the adopted turn ended, the person's turn had no entry for the
 * rest of its life, and the 409 gate let a third message in.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const ROOT = testTmpDir("turn-ledger-registry");
let shared: AppContext;
beforeAll(async () => {
  setupTestDataDir(`${ROOT}/data`);
  shared = await createTestAppContext();
});
afterAll(() => cleanupTestDataDir(ROOT));
/** One context for the file: building one runs every migration. Each test has its own session. */
const context = () => shared;

/** A socket that keeps what it is sent, in the shape `broadcastToAll` writes to. */
function listen(ctx: AppContext): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, data: { id: "t", remote: false }, send: (p: string) => { frames.push(JSON.parse(p)); return 0; } };
  ctx.wsClients.add(ws as never);
  return frames;
}

const turnFrames = (frames: Array<Record<string, unknown>>, sk: string) =>
  frames.filter((f) => f.type === "turn:state" && f.sessionKey === sk).map((f) => `${f.open ? "open" : "closed"}#${f.turnId}`);

describe("turn ledger through createAppContext", () => {
  test("a turn's start and end reach every window, named by the same turn", () => {
    const ctx = context();
    const frames = listen(ctx);
    ctx.startStream("topic:l1", "row-1");
    expect(ctx.turnLedger!.isOpen("topic:l1")).toBe(true);
    ctx.endStream("topic:l1");
    expect(ctx.turnLedger!.isOpen("topic:l1")).toBe(false);
    const said = turnFrames(frames, "topic:l1");
    expect(said).toHaveLength(2);
    expect(said[0]!.replace("open", "closed")).toBe(said[1]);
  });

  test("the adopted CLI turn ends: the parked person's turn is registered again, and still open", () => {
    const ctx = context();
    const frames = listen(ctx);
    ctx.startStream("topic:l2", "person-row");
    ctx.startStream("topic:l2", "woken-row");
    expect(ctx.isStreaming("topic:l2")?.messageId).toBe("woken-row");

    ctx.endStream("topic:l2", { rowId: "woken-row" });
    expect(ctx.isStreaming("topic:l2")?.messageId).toBe("person-row");
    expect(ctx.turnLedger!.isOpen("topic:l2")).toBe(true);

    ctx.endStream("topic:l2", { rowId: "person-row" });
    expect(ctx.isStreaming("topic:l2")).toBeUndefined();
    expect(ctx.turnLedger!.isOpen("topic:l2")).toBe(false);
    // One turn for the session, open to closed: no flicker in between.
    expect(turnFrames(frames, "topic:l2").map((s) => s.split("#")[0])).toEqual(["open", "closed"]);
  });

  test("ending the turn underneath leaves the one on top alone", () => {
    const ctx = context();
    ctx.startStream("topic:l3", "person-row");
    ctx.startStream("topic:l3", "woken-row");
    ctx.endStream("topic:l3", { rowId: "person-row" });
    expect(ctx.isStreaming("topic:l3")?.messageId).toBe("woken-row");
    ctx.endStream("topic:l3", { rowId: "woken-row" });
    expect(ctx.isStreaming("topic:l3")).toBeUndefined();
    expect(ctx.turnLedger!.isOpen("topic:l3")).toBe(false);
  });

  test("the CLI's own turn keeps the session open past the route's end", () => {
    const ctx = context();
    ctx.turnLedger!.set("topic:l4", "cli", true);
    ctx.startStream("topic:l4", "row");
    ctx.endStream("topic:l4");
    expect(ctx.turnLedger!.isOpen("topic:l4")).toBe(true);
    ctx.turnLedger!.set("topic:l4", "cli", false);
    expect(ctx.turnLedger!.isOpen("topic:l4")).toBe(false);
  });
});
