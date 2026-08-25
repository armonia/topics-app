/**
 * Tests for reconcileOrphanStreams — the pure helper that clears a chat's
 * locally-stuck "streaming" flag when the server's streaming registry says the
 * session is no longer mid-reply.
 *
 * This is the self-heal for a MISSED stream:end (WS dropped between
 * stream:start and stream:end): the spinner would otherwise stick true until
 * the 3-min watchdog or a reload.
  * @covers CHAT-STREAM-01
 */
import { describe, test, expect } from "bun:test";
import { reconcileOrphanStreams } from "./signals";

const S = (...xs: string[]) => new Set(xs);
const M = (entries: Array<[string, number]> = []) => new Map(entries);

describe("reconcileOrphanStreams", () => {
  test("a session the server still streams is never an orphan (reset)", () => {
    const r = reconcileOrphanStreams(["a"], S("a"), S(), M([["a", 5]]));
    expect(r.orphans).toEqual([]);
    expect(r.nextMiss.has("a")).toBe(false); // present on server → count reset
  });

  test("an in-flight local send is never touched, even if absent server-side", () => {
    const r = reconcileOrphanStreams(["a"], S(), S("a"), M([["a", 9]]));
    expect(r.orphans).toEqual([]);
    expect(r.nextMiss.has("a")).toBe(false); // own SSE → left alone, count reset
  });

  test("first miss does not clear — it accumulates (needs >= threshold)", () => {
    const r = reconcileOrphanStreams(["a"], S(), S(), M());
    expect(r.orphans).toEqual([]);
    expect(r.nextMiss.get("a")).toBe(1);
  });

  test("reaches threshold on the second consecutive miss → cleared", () => {
    const r = reconcileOrphanStreams(["a"], S(), S(), M([["a", 1]]));
    expect(r.orphans).toEqual(["a"]);
    expect(r.nextMiss.has("a")).toBe(false); // cleared → not carried
  });

  test("a reappearing stream resets the accumulated count", () => {
    // 'a' had 1 miss, but the server now lists it again → back to 0.
    const r = reconcileOrphanStreams(["a"], S("a"), S(), M([["a", 1]]));
    expect(r.orphans).toEqual([]);
    expect(r.nextMiss.has("a")).toBe(false);
  });

  test("honours a custom threshold", () => {
    const once = reconcileOrphanStreams(["a"], S(), S(), M(), 1);
    expect(once.orphans).toEqual(["a"]); // threshold 1 → clears on first miss

    const thrice = reconcileOrphanStreams(["a"], S(), S(), M([["a", 2]]), 4);
    expect(thrice.orphans).toEqual([]);
    expect(thrice.nextMiss.get("a")).toBe(3); // still below 4
  });

  test("handles a mix: live, in-flight, accumulating, and cleared at once", () => {
    const local = ["live", "mine", "warming", "dead"];
    const server = S("live");
    const inflight = S("mine");
    const prev = M([["warming", 0], ["dead", 1]]);
    const r = reconcileOrphanStreams(local, server, inflight, prev);
    expect(r.orphans).toEqual(["dead"]);     // 1 + 1 = 2 ≥ threshold
    expect(r.nextMiss.get("warming")).toBe(1);
    expect(r.nextMiss.has("live")).toBe(false);
    expect(r.nextMiss.has("mine")).toBe(false);
  });

  test("no local streams → empty result", () => {
    const r = reconcileOrphanStreams([], S(), S(), M([["x", 1]]));
    expect(r.orphans).toEqual([]);
    expect(r.nextMiss.size).toBe(0); // stale counts for non-streaming sessions drop
  });
});
