import { describe, expect, test } from "bun:test";
import {
  sweepOnce, startSessionMonitor,
  enableSessionMonitor, disableSessionMonitor, isSessionMonitorRunning,
} from "./session-monitor";

function stubDb(rows: unknown[] | (() => unknown[])) {
  return { query: (_sql: string) => ({ all: () => (typeof rows === "function" ? rows() : rows) }) };
}

describe("sweepOnce", () => {
  test("builds a digest from unread rows", () => {
    const db = stubDb([{ id: "t1", name: "Auth", unread: 2 }, { id: "t2", name: "Billing", unread: 1 }]);
    const d = sweepOnce({ db });
    expect(d.count).toBe(2);
    expect(d.items.map((i) => i.topicId)).toEqual(["t1", "t2"]);
  });

  test("no unread rows → empty digest", () => {
    expect(sweepOnce({ db: stubDb([]) }).count).toBe(0);
  });

  test("DB error degrades to empty (never throws)", () => {
    const db = stubDb(() => { throw new Error("db down"); });
    expect(sweepOnce({ db }).count).toBe(0);
  });
});

describe("startSessionMonitor", () => {
  test("broadcasts master:digest only when something needs attention", () => {
    const msgs: any[] = [];
    const db = stubDb([{ id: "t1", name: "Auth", unread: 1 }]);
    const stop = startSessionMonitor(db, (m) => msgs.push(m), 10, () => 12345);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        stop();
        expect(msgs.length).toBeGreaterThanOrEqual(1);
        expect(msgs[0]).toMatchObject({ type: "master:digest", count: 1, ts: 12345 });
        expect(msgs[0].summary).toContain("Auth");
        resolve();
      }, 40);
    });
  });

  test("stays silent on a quiet workspace", () => {
    const msgs: any[] = [];
    const stop = startSessionMonitor(stubDb([]), (m) => msgs.push(m), 10);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        stop();
        expect(msgs.length).toBe(0);
        resolve();
      }, 40);
    });
  });

  test("stop() halts the timer", async () => {
    const msgs: any[] = [];
    const stop = startSessionMonitor(stubDb([{ id: "t1", name: "A", unread: 1 }]), (m) => msgs.push(m), 10);
    await new Promise((r) => setTimeout(r, 25));
    stop();
    const countAfterStop = msgs.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(msgs.length).toBe(countAfterStop);
  });
});

describe("controlled singleton (enable/disable — user-driven only)", () => {
  test("not running until explicitly enabled; idempotent enable/disable", async () => {
    disableSessionMonitor(); // clean slate
    expect(isSessionMonitorRunning()).toBe(false);

    const msgs: any[] = [];
    enableSessionMonitor(stubDb([{ id: "t1", name: "A", unread: 1 }]), (m) => msgs.push(m), 10);
    expect(isSessionMonitorRunning()).toBe(true);
    enableSessionMonitor(stubDb([]), () => {}, 10); // no-op while running
    expect(isSessionMonitorRunning()).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    disableSessionMonitor();
    expect(isSessionMonitorRunning()).toBe(false);
    const after = msgs.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.length).toBe(after); // stopped → no more pings
    disableSessionMonitor(); // no-op, no throw
  });
});
