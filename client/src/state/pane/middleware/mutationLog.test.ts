/**
 * @covers PANE-04
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { recordAction, subscribe, getRing, clearRing } from "./mutationLog";

describe("mutationLog ring buffer (PANE-05)", () => {
  beforeEach(() => clearRing());

  test("recordAction appends entries in order", () => {
    recordAction({ seq: 1, ts: 100, action: { type: "OPEN_PANE" } });
    recordAction({ seq: 2, ts: 200, action: { type: "CLOSE_PANE" } });
    const ring = getRing();
    expect(ring).toHaveLength(2);
    expect(ring[0].seq).toBe(1);
    expect(ring[1].seq).toBe(2);
  });

  test("ring buffer drops oldest when exceeding RING_SIZE=2000", () => {
    for (let i = 0; i < 2005; i++) {
      recordAction({ seq: i, ts: i, action: { type: "NOOP", i } });
    }
    const ring = getRing();
    expect(ring).toHaveLength(2000);
    expect(ring[0].seq).toBe(5); // 0..4 evicted
    expect(ring[ring.length - 1].seq).toBe(2004);
  });

  test("subscribe fires on every recordAction and returns unsubscribe", () => {
    let fires = 0;
    const unsub = subscribe(() => {
      fires++;
    });
    recordAction({ seq: 1, ts: 1, action: {} });
    recordAction({ seq: 2, ts: 2, action: {} });
    expect(fires).toBe(2);
    unsub();
    recordAction({ seq: 3, ts: 3, action: {} });
    expect(fires).toBe(2);
  });

  test("multiple subscribers fan out", () => {
    let a = 0;
    let b = 0;
    subscribe(() => {
      a++;
    });
    subscribe(() => {
      b++;
    });
    recordAction({ seq: 1, ts: 1, action: {} });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
