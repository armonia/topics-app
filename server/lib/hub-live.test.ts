/**
 * One reader pushes the hub's live data on the socket only when it changed,
 * only while someone is connected, and says so when the hub stops answering.
 * The hub is a stubbed fetch: nothing reaches :3360.
 * @covers HUBBR-02
 */
import { describe, expect, test } from "bun:test";
import { createHubLive, type HubLiveFrame } from "./hub-live";

function harness(opts: { clients?: boolean; base?: string | null } = {}) {
  const answers: Record<string, unknown> = { pace: [{ provider: "claude", pct: 40 }], mac: { cpu: 10 }, services: [] };
  let down = false;
  let calls = 0;
  let clock = 1_000;
  const frames: HubLiveFrame[] = [];
  const live = createHubLive({
    base: () => (opts.base === undefined ? "http://hub" : opts.base),
    broadcast: (f) => frames.push(f),
    hasClients: () => opts.clients ?? true,
    intervalMs: 15_000,
    now: () => clock,
    fetchImpl: (async (url: string) => {
      calls++;
      if (down) throw new Error("ECONNREFUSED");
      const topic = String(url).split("/api/")[1]!;
      return new Response(JSON.stringify(answers[topic]), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return {
    live, frames, answers,
    setDown: (v: boolean) => { down = v; },
    advance: (ms: number) => { clock += ms; },
    calls: () => calls,
  };
}

describe("HUBBR-02: hub live data on the WebSocket", () => {
  test("the first tick pushes one frame per topic", async () => {
    const h = harness();
    await h.live.tick();
    expect(h.frames.map((f) => f.topic).sort()).toEqual(["mac", "pace", "services"]);
    expect(h.frames.find((f) => f.topic === "pace")!.data).toEqual([{ provider: "claude", pct: 40 }]);
    for (const f of h.frames) expect(f.type).toBe("hub:live");
  });

  test("an unchanged answer pushes nothing; a changed one pushes only its topic", async () => {
    const h = harness();
    await h.live.tick();
    h.frames.length = 0;
    await h.live.tick();
    expect(h.frames).toEqual([]);
    h.answers.mac = { cpu: 90 };
    await h.live.tick();
    expect(h.frames.map((f) => f.topic)).toEqual(["mac"]);
    expect(h.frames[0]!.data).toEqual({ cpu: 90 });
  });

  test("a hub that stops answering is one error frame per topic, not repeated, and old numbers are dropped", async () => {
    const h = harness();
    await h.live.tick();
    h.frames.length = 0;
    h.setDown(true);
    await h.live.tick();
    await h.live.tick();
    expect(h.frames.length).toBe(3);
    for (const f of h.frames) {
      expect(f.error).toContain("not reachable");
      expect(f.data).toBeUndefined();
    }
    h.advance(20_000);
    const snap = await h.live.snapshot();
    expect(snap.pace!.data).toBeUndefined();
    expect(snap.pace!.error).toContain("not reachable");
    // Back up: the numbers come back as a fresh frame even if they equal the old ones.
    h.frames.length = 0;
    h.setDown(false);
    await h.live.tick();
    expect(h.frames.length).toBe(3);
  });

  test("snapshot reads the hub only when the last tick is older than the interval", async () => {
    const h = harness();
    await h.live.snapshot();
    const after = h.calls();
    expect(after).toBe(3);
    await h.live.snapshot();
    expect(h.calls()).toBe(after);
    h.advance(15_000);
    await h.live.snapshot();
    expect(h.calls()).toBe(after + 3);
  });

  test("concurrent ticks share one read", async () => {
    const h = harness();
    await Promise.all([h.live.tick(), h.live.tick(), h.live.tick()]);
    expect(h.calls()).toBe(3);
  });

  test("no base (e2e) means no read at all", async () => {
    const h = harness({ base: null });
    await h.live.tick();
    expect(h.calls()).toBe(0);
    expect(h.frames).toEqual([]);
  });

  test("the timer reads only while a window is connected", async () => {
    const h = harness({ clients: false });
    const fast = createHubLive({
      base: () => "http://hub",
      broadcast: () => {},
      hasClients: () => false,
      intervalMs: 5,
      fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    });
    fast.start();
    await Bun.sleep(30);
    fast.stop();
    expect(h.calls()).toBe(0);
  });
});
