import { describe, expect, test } from "bun:test";
import { createBrowserHostBootRace, BOOT_HOST_WAIT_MS, type BootRaceSocket } from "./browser-host-boot-race";
import type { BrowserWsMessage } from "../shared/browser-ws-messages";

/** @covers NATIVE-HOST-06 */

class FakeClock {
  now = 0;
  jobs: { at: number; fn: () => void; live: boolean }[] = [];
  schedule = (fn: () => void, ms: number) => {
    const job = { at: this.now + ms, fn, live: true };
    this.jobs.push(job);
    return () => { job.live = false; };
  };
  advance(ms: number) {
    this.now += ms;
    for (const job of this.jobs.filter((item) => item.live && item.at <= this.now)) { job.live = false; job.fn(); }
  }
}

class Socket implements BootRaceSocket { readyState = 1; data = {}; }

function rig() {
  const clock = new FakeClock();
  const calls: string[] = [];
  const seen = new Set<string>();
  let hosting = false;
  const race = createBrowserHostBootRace({
    schedule: clock.schedule,
    hasSeenHost: (id) => seen.has(id),
    isHosting: () => hosting,
    apply: (_socket, _id, frame) => {
      calls.push(hosting
        ? frame.type === "nav" ? "host_nav" : frame.type === "resize" ? "host_viewport" : "attach_mirror"
        : frame.type === "set_render" ? "enableDomMode" : frame.type === "resize" ? "viewport" : "navigate");
    },
  });
  return { clock, calls, seen, setHosting: (value: boolean) => { hosting = value; }, race };
}

const held: BrowserWsMessage[] = [
  { type: "set_render", mode: "dom" },
  { type: "resize", width: 820, height: 1180 },
  { type: "nav", phase: "request", url: "https://b.example" },
];

describe("native host boot race", () => {
  test("holds Chromium-touching frames until a host claims the context", () => {
    const r = rig();
    const viewer = new Socket();
    expect(r.race.begin(viewer, "ctx", true)).toBe(true);
    for (const frame of held) expect(r.race.hold(viewer, "ctx", frame)).toBe(true);
    expect(r.race.hold(viewer, "ctx", { type: "set_stream", active: true })).toBe(false);
    expect(r.calls).toEqual([]);
    r.clock.advance(3_000);
    r.setHosting(true);
    r.seen.add("ctx");
    r.race.hostReady("ctx");
    expect(r.calls).toEqual(["attach_mirror", "host_viewport", "host_nav"]);
    r.clock.advance(BOOT_HOST_WAIT_MS);
    expect(r.calls).toHaveLength(3);
  });

  test("expires once and replays only the latest frame of each type", () => {
    const r = rig();
    const viewer = new Socket();
    let expirations = 0;
    r.race.begin(viewer, "ctx", true, () => { expirations += 1; });
    for (const frame of held) r.race.hold(viewer, "ctx", frame);
    r.race.hold(viewer, "ctx", { type: "resize", width: 900, height: 1200 });
    expect(r.race.hold(viewer, "ctx", { type: "input", action: "click", payload: {} })).toBe(true);
    expect(r.race.hold(viewer, "ctx", { type: "focus_query" })).toBe(true);
    expect(r.calls).toEqual([]);
    expect(expirations).toBe(0);
    r.clock.advance(BOOT_HOST_WAIT_MS);
    expect(r.calls).toEqual(["enableDomMode", "viewport", "navigate"]);
    expect(expirations).toBe(1);
    r.clock.advance(BOOT_HOST_WAIT_MS);
    expect(r.calls).toHaveLength(3);
    expect(expirations).toBe(1);
  });

  test("does not wait for an old client, a known host, or a currently hosted context", () => {
    const r = rig();
    const viewer = new Socket();
    expect(r.race.begin(viewer, "ctx", false)).toBe(false);
    r.seen.add("ctx");
    expect(r.race.begin(viewer, "ctx", true)).toBe(false);
    r.seen.delete("ctx");
    r.setHosting(true);
    expect(r.race.begin(viewer, "ctx", true)).toBe(false);
  });
});
