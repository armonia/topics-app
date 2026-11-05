/**
 * One reader pushes the hub's live data on the socket only when it changed,
 * only while someone is connected, and says so when the hub stops answering.
 * The hub is a stubbed fetch: nothing reaches :3360.
 * @covers HUBBR-02
 */
import { describe, expect, test } from "bun:test";
import { createHubLive, HUB_LIVE_PATHS, HUB_LIVE_TOPICS, type HubLiveFrame } from "./hub-live";

const N = HUB_LIVE_TOPICS.length;

function harness(opts: { clients?: boolean; base?: string | null } = {}) {
  const answers: Record<string, unknown> = {
    pace: [{ provider: "claude", pct: 40 }], mac: { cpu: 10 }, services: [],
    attesa: { items: [] }, alerts: { firing: [] }, gates: { classes: {} }, "automations/summary": { broken: 0 },
    live: { projects: [{ name: "acme-web", state: "attivo", total: 12, claude: 4, codex: 8, agents: { count: 1 }, lastSeen: { at: 1 } }] },
  };
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
    expect(h.frames.map((f) => f.topic).sort()).toEqual([...HUB_LIVE_TOPICS].sort());
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
    expect(h.frames.length).toBe(N);
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
    expect(h.frames.length).toBe(N);
  });

  test("snapshot reads the hub only when the last tick is older than the interval", async () => {
    const h = harness();
    await h.live.snapshot();
    const after = h.calls();
    expect(after).toBe(N);
    await h.live.snapshot();
    expect(h.calls()).toBe(after);
    h.advance(15_000);
    await h.live.snapshot();
    expect(h.calls()).toBe(after + N);
  });

  test("snapshot reads again at once when a topic was unreadable, so a hub that came back shows up", async () => {
    const h = harness();
    h.setDown(true);
    await h.live.tick();
    h.setDown(false);
    const snap = await h.live.snapshot();
    expect(snap.attesa!.data).toEqual({ items: [] });
    expect(snap.attesa!.error).toBeUndefined();
  });

  test("each topic reads its own hub path; automations reads the summary, not the full list", async () => {
    const urls: string[] = [];
    const live = createHubLive({
      base: () => "http://hub",
      broadcast: () => {},
      hasClients: () => true,
      fetchImpl: (async (url: string) => { urls.push(String(url)); return new Response("{}"); }) as unknown as typeof fetch,
    });
    await live.tick();
    expect(urls.sort()).toEqual(HUB_LIVE_TOPICS.map((t) => `http://hub/api/${HUB_LIVE_PATHS[t]}`).sort());
    expect(urls).toContain("http://hub/api/automations/summary");
  });

  test("projects keep only what the project row reads: a change of agents alone sends no frame", async () => {
    const h = harness();
    await h.live.tick();
    const first = h.frames.find((f) => f.topic === "projects");
    // The Claude share stays: the budget is measured on it alone.
    expect(first?.data).toEqual({ projects: [{ name: "acme-web", state: "attivo", total: 12, claude: 4 }] });
    h.answers.live = { projects: [{ name: "acme-web", state: "attivo", total: 12, claude: 4, codex: 8, agents: { count: 3 }, lastSeen: { at: 2 } }] };
    h.frames.length = 0;
    h.advance(15_000);
    await h.live.tick();
    expect(h.frames.filter((f) => f.topic === "projects")).toEqual([]);
    h.answers.live = { projects: [{ name: "acme-web", state: "frenato", why: "budget finito", total: 12 }] };
    await h.live.tick();
    expect(h.frames.filter((f) => f.topic === "projects").map((f) => f.data)).toEqual([{ projects: [{ name: "acme-web", state: "frenato", why: "budget finito", total: 12 }] }]);
  });

  test("refresh after a write reads anew instead of sharing a read already in flight", async () => {
    const h = harness();
    const first = h.live.tick();
    h.answers.attesa = { items: [{ id: "a" }] };
    const refreshed = h.live.refresh();
    await Promise.all([first, refreshed]);
    expect(h.calls()).toBe(2 * N);
    const snap = await h.live.snapshot();
    expect(snap.attesa!.data).toEqual({ items: [{ id: "a" }] });
  });

  test("concurrent ticks share one read", async () => {
    const h = harness();
    await Promise.all([h.live.tick(), h.live.tick(), h.live.tick()]);
    expect(h.calls()).toBe(N);
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
