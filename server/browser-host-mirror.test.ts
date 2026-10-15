import { describe, test, expect } from "bun:test";
import { createHostMirror, type MirrorSocket } from "./browser-host-mirror";
import { createDomHostRegistry } from "./lib/native-dom-host";

/** @covers NATIVE-HOST-01 */

const CTX = "ctx-1";
const meta = { type: 4, data: { href: "https://a.example", width: 800, height: 600 } };
const full = { type: 2, data: { node: { type: 0, childNodes: [] } } };

class FakeSocket implements MirrorSocket {
  readyState = 1;
  data: MirrorSocket["data"] = {};
  sent: Record<string, unknown>[] = [];
  streams: boolean[] = [];
  constructor(delegate = false) {
    this.data._nativeDelegate = delegate || undefined;
    this.data._browserSetStream = (on) => { this.streams.push(on); };
  }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  types() { return this.sent.map((m) => String(m.type)); }
}

function rig(domBootstrap: unknown[] | null = [meta, full]) {
  const sockets = new Set<FakeSocket>();
  const calls: string[] = [];
  let currentUrl: string | null = null;
  const timers: { fn: () => void; live: boolean }[] = [];
  const hosts = createDomHostRegistry();
  const mirror = createHostMirror({
    hosts,
    sockets: () => sockets,
    browser: {
      enableDomMode: async (c) => { calls.push(`enableDomMode ${c}`); return domBootstrap; },
      destroyContext: async (c) => { calls.push(`destroyContext ${c}`); },
      navigate: async (c, u) => { calls.push(`navigate ${c} ${u}`); currentUrl = u; return { url: u, title: "" }; },
      getUrl: () => currentUrl ? { url: currentUrl, title: "" } : null,
    },
    schedule: (fn) => { const t = { fn, live: true }; timers.push(t); return () => { t.live = false; }; },
  });
  const host = new FakeSocket(true);
  sockets.add(host);
  const declare = () => {
    mirror.onHostFrame(host, CTX, { type: "native_dom_host" });
    mirror.onHostFrame(host, CTX, { type: "host_page", url: "https://a.example", title: "A" });
  };
  const viewer = () => { const v = new FakeSocket(); sockets.add(v); return v; };
  const fire = () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn(); } };
  return { sockets, calls, hosts, mirror, host, declare, viewer, fire, setCurrentUrl: (url: string) => { currentUrl = url; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("host mirror wiring", () => {
  test("a host that declares itself takes the viewers already there, and the Chromium context goes", () => {
    const r = rig();
    const v = r.viewer();
    r.declare();
    expect(r.host.types()).toContain("native_dom_host_ack");
    expect(v.sent[0]).toEqual({ type: "render_mode", mode: "dom", host: "native" });
    expect(v.streams).toEqual([false]);
    expect(r.calls).toEqual([`destroyContext ${CTX}`]);
    // A mirror on screen: the host is asked to record.
    expect(r.host.types()).toContain("host_dom_start");
  });

  test("only the registered executor can host", () => {
    const r = rig();
    const stranger = r.viewer();
    r.mirror.onHostFrame(stranger, CTX, { type: "native_dom_host" });
    expect(r.hosts.isHosting(CTX)).toBe(false);
  });

  test("the host's events reach the mirrors, not the host and not a viewer still on video", () => {
    const r = rig();
    r.declare();
    const mirror = r.viewer();
    r.mirror.routeViewer(mirror, CTX, { type: "set_render", mode: "dom" });
    const video = r.viewer();
    r.mirror.onHostFrame(r.host, CTX, { type: "host_dom_events", events: [meta, full] });
    expect(mirror.sent.filter((m) => m.type === "dom_event")).toHaveLength(2);
    expect(video.sent).toEqual([]);
    expect(r.host.types().filter((t) => t === "dom_event")).toEqual([]);
  });

  /** @covers BROWSER-DOM-LAYOUT-01 */
  test("a pane that lays the page out on its own uses it without resizing the Mac", () => {
    for (const layout of ["own", "page"] as const) {
      const r = rig();
      r.declare();
      const v = r.viewer();
      r.mirror.routeViewer(v, CTX, { type: "resize", width: 820, height: 1180, layout });
      r.mirror.routeViewer(v, CTX, { type: "input", action: "click", payload: { x: 5, y: 6 } });
      const told = r.host.sent.filter((m) => m.type === "host_viewport");
      expect(r.host.sent.some((m) => m.type === "host_input")).toBe(true);
      expect(told).toEqual(layout === "own" ? [] : [{ type: "host_viewport", width: 820, height: 1180 }]);
    }
  });

  test("a device driving the page that switches to its own layout gives it back without resizing the Mac again", () => {
    const r = rig();
    r.declare();
    const v = r.viewer();
    r.mirror.routeViewer(v, CTX, { type: "resize", width: 820, height: 1180, layout: "page" });
    r.mirror.routeViewer(v, CTX, { type: "input", action: "click", payload: { x: 5, y: 6 } });
    const before = r.host.sent.length;
    // A new size and the switch in the same frame: the switch counts first.
    r.mirror.routeViewer(v, CTX, { type: "resize", width: 700, height: 1000, layout: "own" });
    expect(r.host.sent.slice(before).filter((m) => m.type === "host_viewport")).toEqual([{ type: "host_viewport" }]);
  });

  test("a viewer's input and navigation go to the host; nothing reaches the browser service", () => {
    const r = rig();
    r.declare();
    const v = r.viewer();
    expect(r.mirror.routeViewer(v, CTX, { type: "input", action: "click", payload: { x: 5, y: 6 } })).toBe(true);
    expect(r.mirror.routeViewer(v, CTX, { type: "nav", url: "https://a.example", phase: "request" })).toBe(true);
    expect(r.mirror.routeViewer(v, CTX, { type: "nav", url: "https://b.example", phase: "request" })).toBe(true);
    expect(r.mirror.routeViewer(v, CTX, { type: "resize", width: 300, height: 200 })).toBe(true);
    const commands = r.host.sent.filter((m) => m.type === "host_input" || m.type === "host_nav");
    expect(commands).toEqual([
      { type: "host_input", action: "click", payload: { x: 5, y: 6 } },
      { type: "host_nav", action: "navigate", url: "https://b.example" },
    ]);
    // The seed of the url the Mac is already on is answered with where it is.
    expect(v.sent.some((m) => m.type === "nav" && m.url === "https://a.example")).toBe(true);
    expect(r.calls).toEqual([`destroyContext ${CTX}`]);
  });

  test("the recorder stops when the last mirror leaves the screen, and starts again when it is back", () => {
    const r = rig();
    r.declare();
    const v = r.viewer();
    r.mirror.routeViewer(v, CTX, { type: "set_render", mode: "dom" });
    v.data._watching = false;
    r.mirror.sync(CTX);
    v.data._watching = true;
    r.mirror.sync(CTX);
    expect(r.host.types().filter((t) => t.startsWith("host_dom_"))).toEqual(["host_dom_start", "host_dom_stop", "host_dom_start"]);
  });

  test("when the host leaves, the server's Chromium takes over at its page after the grace", async () => {
    const r = rig();
    r.declare();
    const v = r.viewer();
    r.mirror.routeViewer(v, CTX, { type: "set_render", mode: "dom" });
    r.sockets.delete(r.host);
    r.mirror.onClose(r.host, CTX);
    expect(v.sent).toContainEqual({ type: "host_away" });
    r.mirror.onClose(r.host, CTX);
    expect(r.calls).toEqual([`destroyContext ${CTX}`]);
    r.fire();
    await flush(); await flush();
    expect(r.calls).toEqual([`destroyContext ${CTX}`, `navigate ${CTX} https://a.example`, `enableDomMode ${CTX}`]);
    expect(v.sent.at(-1)).toEqual({ type: "dom_event", event: full });
  });

  test("a host back within the grace cancels the fallback", async () => {
    const r = rig();
    r.declare();
    r.mirror.routeViewer(r.viewer(), CTX, { type: "set_render", mode: "dom" });
    r.mirror.onClose(r.host, CTX);
    r.declare();
    r.fire();
    await flush();
    expect(r.calls.filter((c) => c.startsWith("enableDomMode"))).toEqual([]);
  });

  /** @covers NATIVE-HOST-08 */
  test("a returning host receives a fallback navigation before the viewers move back", async () => {
    const r = rig();
    r.declare();
    const viewer = r.viewer();
    r.mirror.routeViewer(viewer, CTX, { type: "set_render", mode: "dom" });
    r.sockets.delete(r.host);
    r.mirror.onClose(r.host, CTX);
    r.fire();
    await flush(); await flush();
    r.setCurrentUrl("https://b.example/new");
    const returning = new FakeSocket(true);
    r.sockets.add(returning);
    r.mirror.onHostFrame(returning, CTX, { type: "native_dom_host" });
    r.mirror.onHostFrame(returning, CTX, { type: "host_page", url: "https://a.example" });
    expect(returning.sent).toContainEqual({ type: "host_nav", action: "navigate", url: "https://b.example/new" });
    expect(viewer.sent).toContainEqual({ type: "nav", url: "https://b.example/new", phase: "request" });
  });

  test("a context nobody hosts keeps its old path", () => {
    const r = rig();
    expect(r.mirror.routeViewer(r.viewer(), CTX, { type: "input", action: "click", payload: {} })).toBe(false);
  });

  test("a failed DOM bootstrap resumes the viewer stream", async () => {
    const r = rig(null);
    const viewer = r.viewer();
    r.mirror.enableChromiumDom(viewer, CTX);
    await flush();
    expect(viewer.sent).toContainEqual({ type: "render_mode", mode: "video" });
    expect(viewer.streams).toEqual([true]);
  });

  /** @covers BROWSER-NATIVE-HOST-STATUS-01 */
  test("host status counts devices and stop sharing blocks frames and viewer input until a fresh snapshot", () => {
    const r = rig();
    r.declare();
    const first = r.viewer();
    first.data.deviceId = "ipad";
    r.mirror.routeViewer(first, CTX, { type: "set_render", mode: "dom" });
    const second = r.viewer();
    second.data.deviceId = "ipad";
    r.mirror.routeViewer(second, CTX, { type: "set_render", mode: "dom" });
    r.fire();
    expect(r.host.sent.find((m) => m.type === "native_host_status")).toMatchObject({ devices: 1, sharing: true });
    expect(first.types()).not.toContain("native_host_status");

    r.mirror.setSharing(CTX, r.host, false);
    expect(first.sent.at(-1)).toEqual({ type: "host_share_state", sharing: false });
    const framesBefore = first.types().filter((t) => t === "dom_event").length;
    r.mirror.onHostFrame(r.host, CTX, { type: "host_dom_events", events: [full] });
    expect(first.types().filter((t) => t === "dom_event").length).toBe(framesBefore);
    const inputsBefore = r.host.types().filter((t) => t === "host_input").length;
    expect(r.mirror.routeViewer(first, CTX, { type: "input", action: "click", payload: {} })).toBe(true);
    expect(r.host.types().filter((t) => t === "host_input").length).toBe(inputsBefore);

    const late = r.viewer();
    r.mirror.attachIfIdle(late, CTX);
    expect(late.types()).not.toContain("dom_event");
    expect(late.types()).toContain("host_share_state");
    r.mirror.setSharing(CTX, r.host, true);
    r.mirror.onHostFrame(r.host, CTX, { type: "host_dom_events", events: [meta, full] });
    expect(late.sent.filter((m) => m.type === "dom_event")).toEqual([{ type: "dom_event", event: meta }, { type: "dom_event", event: full }]);
  });

  test("a disconnected host does not resume a paused mirror through Chromium fallback", async () => {
    const r = rig();
    r.declare();
    const viewer = r.viewer();
    r.mirror.routeViewer(viewer, CTX, { type: "set_render", mode: "dom" });
    r.mirror.setSharing(CTX, r.host, false);
    r.sockets.delete(r.host);
    r.mirror.onClose(r.host, CTX);
    expect(r.mirror.routeViewer(viewer, CTX, { type: "input", action: "click", payload: {} })).toBe(true);
    r.fire();
    await flush();
    expect(r.calls).toEqual([`destroyContext ${CTX}`]);
  });
});
