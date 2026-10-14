import { describe, test, expect } from "bun:test";
import { createDomHostRegistry, parseHostFrame, type HostCommand } from "./native-dom-host";

/** @covers NATIVE-HOST-01 */

const CTX = "ctx-1";
const meta = { type: 4, data: { href: "https://example.com", width: 800, height: 600 } };
const full = { type: 2, data: { node: { type: 0, childNodes: [] } } };
const increment = (n: number) => ({ type: 3, data: { source: 1, n } });

function hostOn(registry = createDomHostRegistry()) {
  const sent: HostCommand[] = [];
  const owner = {};
  registry.declare(CTX, owner, (cmd) => sent.push(cmd));
  return { registry, owner, sent };
}

describe("native DOM host", () => {
  test("the recorder starts with the first viewer and stops with the last", () => {
    const { registry, sent } = hostOn();
    registry.setWanted(CTX, true);
    registry.setWanted(CTX, true);
    registry.setWanted(CTX, false);
    expect(sent.map((c) => c.type)).toEqual(["host_dom_start", "host_dom_stop"]);
  });

  test("a viewer joining a live recording replays meta, snapshot and what came after", () => {
    const { registry, owner } = hostOn();
    registry.setWanted(CTX, true);
    expect(registry.bootstrap(CTX)).toEqual([]);
    expect(registry.ingest(CTX, owner, [meta, full, increment(1), increment(2)])).toHaveLength(4);
    expect(registry.bootstrap(CTX)).toEqual([meta, full, increment(1), increment(2)]);
  });

  test("a new snapshot (the host navigated) restarts the buffer", () => {
    const { registry, owner } = hostOn();
    registry.setWanted(CTX, true);
    registry.ingest(CTX, owner, [meta, full, increment(1)]);
    const meta2 = { type: 4, data: { href: "https://example.com/2" } };
    const full2 = { type: 2, data: { node: { type: 0, childNodes: [], v: 2 } } };
    registry.ingest(CTX, owner, [meta2, full2, increment(3)]);
    expect(registry.bootstrap(CTX)).toEqual([meta2, full2, increment(3)]);
  });

  test("past the cap the buffer cannot rebuild the page: the host is asked for a fresh snapshot, once", () => {
    const registry = createDomHostRegistry(3);
    const { owner, sent } = hostOn(registry);
    registry.setWanted(CTX, true);
    registry.ingest(CTX, owner, [meta, full, increment(1), increment(2), increment(3), increment(4)]);
    expect(registry.bootstrap(CTX)).toEqual([]);
    expect(registry.bootstrap(CTX)).toEqual([]);
    expect(sent.filter((c) => c.type === "host_dom_snapshot")).toHaveLength(1);
    registry.ingest(CTX, owner, [meta, full]);
    expect(registry.bootstrap(CTX)).toEqual([meta, full]);
  });

  test("events of a stopped recorder, or of a socket that is not the host, go nowhere", () => {
    const { registry, owner } = hostOn();
    expect(registry.ingest(CTX, owner, [meta, full])).toEqual([]);
    registry.setWanted(CTX, true);
    expect(registry.ingest(CTX, {}, [meta, full])).toEqual([]);
  });

  test("increments with no snapshot under them since the start reach nobody", () => {
    const { registry, owner } = hostOn();
    registry.setWanted(CTX, true);
    expect(registry.ingest(CTX, owner, [increment(1), increment(2)])).toEqual([]);
    expect(registry.ingest(CTX, owner, [meta, full, increment(3)])).toEqual([meta, full, increment(3)]);
  });

  test("resources only the Mac can reach are routed before they are buffered", () => {
    const { registry, owner } = hostOn();
    registry.setWanted(CTX, true);
    const img = { type: 2, tagName: "img", attributes: { src: "http://localhost:5173/a.png" }, childNodes: [] };
    registry.ingest(CTX, owner, [meta, { type: 2, data: { node: { type: 0, childNodes: [img] } } }]);
    expect(img.attributes.src).toStartWith(`/api/browser/resource?ctx=${CTX}&u=`);
  });

  test("a stale socket cannot withdraw the host that replaced it", () => {
    const { registry, owner } = hostOn();
    const fresh = {};
    registry.declare(CTX, fresh, () => {});
    expect(registry.withdraw(CTX, owner)).toBe(false);
    expect(registry.isHosting(CTX)).toBe(true);
    expect(registry.withdraw(CTX, fresh)).toBe(true);
    expect(registry.isHosting(CTX)).toBe(false);
  });

  test("the last page survives the host, for whoever takes over", () => {
    const { registry, owner } = hostOn();
    expect(registry.notePage(CTX, owner, { url: "https://a.example", title: "A" })).toBe(true);
    expect(registry.notePage(CTX, owner, { url: "https://a.example", title: "A" })).toBe(false);
    registry.withdraw(CTX, owner);
    expect(registry.page(CTX)?.url).toBe("https://a.example");
    expect(registry.command(CTX, { type: "host_dom_start" })).toBe(false);
  });
});

describe("parseHostFrame", () => {
  test("host frames are recognised, everything else is left to the streaming schema", () => {
    expect(parseHostFrame({ type: "native_dom_host" })).toEqual({ type: "native_dom_host" });
    expect(parseHostFrame({ type: "host_dom_events", events: [meta] })).toEqual({ type: "host_dom_events", events: [meta] });
    expect(parseHostFrame({ type: "host_page", url: "https://a.example", title: 3 })).toEqual({ type: "host_page", url: "https://a.example" });
    expect(parseHostFrame({ type: "host_dom_events", events: "x" })).toBeNull();
    expect(parseHostFrame({ type: "input", action: "click" })).toBeNull();
  });
});
