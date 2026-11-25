/**
 * The «waiting for you» inbox Topics owns: one item per identity, bridged from the hub, closed from Topics.
 *
 * @covers HUBBR-01
 */
import { describe, expect, test } from "bun:test";
import { createWaitingStore } from "./waiting-items";
import { createHubRouter } from "../routes/hub";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const hubItem = (over: Record<string, unknown> = {}) => ({ id: "h1", tipo: "decisione", title: "Pick one", why: "", link: null, from: "agent", at: 1000, ...over });

describe("waiting inbox", () => {
  test("an item opened through the hub and again natively shows once, by key", () => {
    const s = createWaitingStore({ now: () => 5000 });
    s.ingestHubItems([hubItem({ key: "k" })]);
    s.open({ tipo: "decisione", title: "Pick one, reworded", from: "other", key: "k" });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.at).toBe(1000);
  });

  test("an ingested item closed here is not brought back by the hub's next list", () => {
    const s = createWaitingStore();
    s.ingestHubItems([hubItem()]);
    const id = s.list()[0]!.id;
    expect(s.close(id)).toBe(true);
    s.ingestHubItems([hubItem()]);
    expect(s.list()).toHaveLength(0);
  });

  test("once the hub stops listing a closed item, the same id shows again when it is reopened", () => {
    const s = createWaitingStore();
    s.ingestHubItems([hubItem()]);
    s.close(s.list()[0]!.id);
    s.ingestHubItems([]);
    s.ingestHubItems([hubItem()]);
    expect(s.list()).toHaveLength(1);
  });

  test("a snoozed item returns after its until", () => {
    let t = 1000;
    const s = createWaitingStore({ now: () => t });
    const id = s.open({ tipo: "spesa", title: "x" }).id;
    s.close(id, { until: 2000 });
    expect(s.list()).toHaveLength(0);
    t = 3000;
    expect(s.list()).toHaveLength(1);
  });

  test("the due date puts an item first", () => {
    const s = createWaitingStore({ now: () => 100 });
    s.open({ tipo: "vista", title: "old" });
    s.open({ tipo: "vista", title: "urgent", due: 5000 });
    expect(s.list().map((i) => i.title)).toEqual(["urgent", "old"]);
  });

  test("closing through the bridge route reaches the hub for the bridged ids", async () => {
    const store = createWaitingStore();
    store.ingestHubItems([hubItem()]);
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => { calls.push({ url, body: String(init?.body) }); return json({ ok: true }); }) as unknown as typeof fetch;
    const router = createHubRouter({ json: (b: unknown, s?: number) => json(b, s ?? 200) } as never, { fetchImpl, hubBase: () => "http://hub", waiting: store });
    const req = new Request("http://x/api/hub/attesa", { method: "POST", body: JSON.stringify({ kind: "chiudi", ref: store.list()[0]!.id }) });
    const res = await router(req, new URL(req.url), "/api/hub/attesa", "POST");
    expect(res?.status).toBe(200);
    expect(store.list()).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body).ref).toBe("h1");
  });
});

describe("hub close seen through the bridge", () => {
  test("an item the hub stops listing leaves the inbox", () => {
    const store = createWaitingStore();
    store.ingestHubItems([{ id: "h1", tipo: "vista", title: "look", from: "x" }]);
    expect(store.list()).toHaveLength(1);
    store.ingestHubItems([]);
    expect(store.list()).toHaveLength(0);
  });
});
