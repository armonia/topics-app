/**
 * One reader pushes the hub's live data on the socket only when it changed,
 * only while someone is connected, and says so when the hub stops answering.
 * The hub is a stubbed fetch: nothing reaches :3360.
 * @covers HUBBR-02
 */
import { describe, expect, test } from "bun:test";
import { createHubLive, HUB_LIVE_EVERY, HUB_LIVE_PATHS, HUB_LIVE_TOPICS, type HubLiveFrame } from "./hub-live";

const N = HUB_LIVE_TOPICS.length;
/** The topics read every tick: the slow ones (services, pc) wait their turn. */
const EVERY_TICK = HUB_LIVE_TOPICS.filter((t) => (HUB_LIVE_EVERY[t] ?? 1) <= 1).length;

function harness(opts: { clients?: boolean; base?: string | null } = {}) {
  const answers: Record<string, unknown> = {
    pace: [{ provider: "claude", pct: 40 }], mac: { cpu: 10 }, services: [],
    attesa: { items: [] }, alerts: { firing: [] }, gates: { classes: {} }, "automations/summary": { broken: 0 },
    live: { projects: [{ name: "acme-web", state: "attivo", total: 12, claude: 4, codex: 8, agents: { count: 1 }, lastSeen: { at: 1 } }] },
    forecast: { at: 1_000, headline: { title: "x" }, providers: [{ id: "claude", status: "corto", level: 2, runsOutAt: 1_000 + 3_600_000, right: "finisce oggi alle 18:00", sub: "3 account", ends: {} }] },
    pc: { pc: "chiuso", perche: "inattivo da 1 min" },
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
    expect(h.calls()).toBe(after + EVERY_TICK);
  });

  test("services and the PC are read once every four ticks, the rest every tick", async () => {
    const h = harness();
    const urls: string[] = [];
    const counting = createHubLive({
      base: () => "http://hub", broadcast: () => {}, hasClients: () => true,
      fetchImpl: (async (url: string) => { urls.push(String(url).split("/api/")[1]!); return new Response(JSON.stringify(h.answers[String(url).split("/api/")[1]!] ?? {})); }) as unknown as typeof fetch,
    });
    for (let i = 0; i < 8; i++) await counting.tick();
    expect(urls.filter((u) => u === "services").length).toBe(2);
    expect(urls.filter((u) => u === "pc").length).toBe(2);
    expect(urls.filter((u) => u === "mac").length).toBe(8);
  });

  test("a hub that stops answering drops the slow topics too, without waiting for their turn", async () => {
    const h = harness();
    await h.live.tick();
    h.setDown(true);
    h.frames.length = 0;
    await h.live.tick();
    expect(h.frames.map((f) => f.topic).sort()).toEqual([...HUB_LIVE_TOPICS].sort());
    const snap = await h.live.snapshot();
    expect(snap.services!.data).toBeUndefined();
    expect(snap.pc!.data).toBeUndefined();
  });

  test("the forecast keeps the sentence and whether it runs out within a day; the PC keeps its state alone", async () => {
    const h = harness();
    await h.live.tick();
    expect(h.frames.find((f) => f.topic === "forecast")!.data).toEqual({
      providers: [{ id: "claude", status: "corto", level: 2, right: "finisce oggi alle 18:00", sub: "3 account", soon: true }],
    });
    expect(h.frames.find((f) => f.topic === "pc")!.data).toEqual({ pc: "chiuso" });
    // The hub's clock and the exact minute move on every read: no frame for that alone.
    h.answers.forecast = { at: 9_000, providers: [{ id: "claude", status: "corto", level: 2, runsOutAt: 9_000 + 3_000_000, right: "finisce oggi alle 18:00", sub: "3 account" }] };
    h.frames.length = 0;
    await h.live.tick();
    expect(h.frames.filter((f) => f.topic === "forecast")).toEqual([]);
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
    expect(first?.data).toEqual({ projects: [{ name: "acme-web", state: "attivo", total: 12, claude: 4 }], agentsOutside: 0 });
    h.answers.live = { projects: [{ name: "acme-web", state: "attivo", total: 12, claude: 4, codex: 8, agents: { count: 3 }, lastSeen: { at: 2 } }] };
    h.frames.length = 0;
    h.advance(15_000);
    await h.live.tick();
    expect(h.frames.filter((f) => f.topic === "projects")).toEqual([]);
    h.answers.live = { projects: [{ name: "acme-web", state: "frenato", why: "budget finito", total: 12 }] };
    await h.live.tick();
    expect(h.frames.filter((f) => f.topic === "projects").map((f) => f.data)).toEqual([{ projects: [{ name: "acme-web", state: "frenato", why: "budget finito", total: 12 }], agentsOutside: 0 }]);
  });

  test("the agents at work outside Topics are a count, the ones in a Topics tab left out (HUBBR-13)", async () => {
    const h = harness();
    const agent = (via: string | null) => ({ kind: "sessione", provider: "claude", ...(via ? { open: { via } } : {}) });
    h.answers.live = { projects: [
      { name: "acme-web", state: "attivo", total: 12, agents: { count: 3, list: [agent("tab Topics"), agent(null), agent("Claude Code desktop")] } },
      { name: "studio-x", state: "attivo", total: 2, agents: { count: 1, list: [{ kind: "codex", provider: "codex" }] } },
    ] };
    await h.live.tick();
    expect((h.frames.find((f) => f.topic === "projects")?.data as { agentsOutside?: number }).agentsOutside).toBe(3);
  });

  test("refresh after a write reads anew instead of sharing a read already in flight", async () => {
    const h = harness();
    const first = h.live.tick();
    h.answers.attesa = { items: [{ id: "a" }] };
    const refreshed = h.live.refresh();
    await Promise.all([first, refreshed]);
    // The write's read asks every topic: a write can change any of them.
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
