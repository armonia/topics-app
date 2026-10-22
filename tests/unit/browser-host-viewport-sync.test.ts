/**
 * The Mac's pane and the server agree on whose layout a hosted page has.
 *
 * The real Mac-side protocol (client nativeDomHost) wired to the real server
 * mirror (server browser-host-mirror), both ways, the way the executor socket
 * wires them. Each test is a sequence that once left the Mac laid out at a size
 * nobody was using, or the server counting a device as the driver while the
 * Mac showed its own layout.
 *
 * @covers NATIVE-HOST-04
 */
import { describe, expect, test } from "bun:test";
import { createHostMirror, type MirrorSocket } from "../../server/browser-host-mirror";
import { createDomHostRegistry, parseHostFrame } from "../../server/lib/native-dom-host";
import { createNativeDomHost } from "../../client/src/lib/nativeDomHost";
import type { BrowserWsMessage } from "../../shared/browser-ws-messages";

const CTX = "ctx-1";
const flush = () => new Promise((done) => setTimeout(done, 0));
type Size = { width: number; height: number } | null;

class Socket implements MirrorSocket {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onSend?: (m: Record<string, unknown>) => void;
  constructor(public data: MirrorSocket["data"]) {}
  send(text: string) {
    const m = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(m);
    this.onSend?.(m);
  }
}

function rig() {
  const sockets = new Set<Socket>();
  const mirror = createHostMirror({
    hosts: createDomHostRegistry(),
    sockets: () => sockets,
    browser: { enableDomMode: async () => [], destroyContext: async () => {}, navigate: async (_c, u) => ({ url: u, title: "" }) },
    schedule: () => () => {},
  });
  // What the Mac's pane is laid out at, in the order it was told.
  const applied: Size[] = [];
  let hostSocket: Socket | null = null;
  const mac = createNativeDomHost({
    evalInPage: async () => "",
    loadRecorder: async () => "",
    sendText: (text) => {
      const frame = parseHostFrame(JSON.parse(text));
      if (frame && hostSocket?.readyState === 1) mirror.onHostFrame(hostSocket, CTX, frame);
    },
    navigate: () => {},
    setViewport: (size) => { applied.push(size); },
    schedule: () => () => {},
  });
  /** The executor socket (re)opens: the pane declares itself again. */
  const connect = () => {
    hostSocket = new Socket({ _nativeDelegate: true, id: "mac-exec", clientId: "mac", remote: false });
    hostSocket.onSend = (m) => { mac.handle(m); };
    sockets.add(hostSocket);
    mac.declare();
  };
  /** A blip: the socket closes on both ends. */
  const drop = () => {
    const s = hostSocket!;
    s.readyState = 3;
    sockets.delete(s);
    mirror.onClose(s, CTX);
    mac.reset();
  };
  const ipad = new Socket({ id: "ipad-1", deviceId: "ipad", clientId: "pane-1", remote: true });
  sockets.add(ipad);
  const say = (m: BrowserWsMessage) => mirror.routeViewer(ipad, CTX, m);
  const told = () => hostSocket!.sent.filter((m) => m.type === "host_viewport");
  return { mirror, mac, applied, connect, drop, ipad, say, told, layout: () => applied.at(-1) ?? null };
}

const TAP = { type: "input", action: "click", payload: { x: 1, y: 1 } } as const;

describe("hosted page: the Mac and the server agree on whose layout it is", () => {
  test("the iPad using the page lays the Mac out at its size, and the Mac using it takes it back", async () => {
    const r = rig();
    r.connect();
    r.say({ type: "resize", width: 1180, height: 820 });
    r.say(TAP);
    await flush();
    expect(r.layout()).toEqual({ width: 1180, height: 820 });
    r.mac.noteLocalUse();
    await flush();
    expect(r.layout()).toBeNull();
    // Now only watching: its next resize moves nothing.
    r.say({ type: "resize", width: 820, height: 1180 });
    await flush();
    expect(r.layout()).toBeNull();
  });

  test("the iPad taking the page off its screen gives it back to the Mac, and has it again when it is back", async () => {
    const r = rig();
    r.connect();
    r.say({ type: "set_render", mode: "dom" });
    r.say({ type: "resize", width: 1180, height: 820 });
    r.say(TAP);
    await flush();
    const watching = async (on: boolean) => {
      r.ipad.data._watching = on;
      r.mirror.onWatching(r.ipad, CTX);
      await flush();
    };
    await watching(false);
    expect(r.layout()).toBeNull();
    await watching(true);
    expect(r.layout()).toEqual({ width: 1180, height: 820 });
    // Unless the Mac used the page while the iPad was away.
    await watching(false);
    r.mac.noteLocalUse();
    await watching(true);
    expect(r.layout()).toBeNull();
  });

  test("a size the iPad sent before the Mac hosted is the one its first touch lays out", async () => {
    const r = rig();
    expect(r.say({ type: "resize", width: 1180, height: 820 })).toBe(false);
    r.connect();
    // Its claim throttled: the touch alone.
    r.say(TAP);
    await flush();
    expect(r.layout()).toEqual({ width: 1180, height: 820 });
  });

  test("a claim whose size is still on its way does not land after the Mac took the page back", async () => {
    const r = rig();
    r.connect();
    // A pane whose size never reached the server: the touch counts it as the driver.
    r.say(TAP);
    await flush();
    expect(r.told()).toEqual([]);
    r.mac.noteLocalUse();
    r.say({ type: "resize", width: 820, height: 1180 });
    await flush();
    expect(r.told()).toEqual([]);
    expect(r.layout()).toBeNull();
  });

  test("the Mac used while its socket was down: the host that comes back keeps its own layout", async () => {
    const r = rig();
    r.connect();
    r.say({ type: "resize", width: 1180, height: 820 });
    r.say(TAP);
    await flush();
    r.drop();
    expect(r.layout()).toBeNull();
    r.mac.noteLocalUse();
    r.connect();
    await flush();
    expect(r.layout()).toBeNull();
    expect(r.told()).toEqual([]);
  });

  test("a host that comes back after a blip shows the iPad again, at the size it turned to meanwhile", async () => {
    const r = rig();
    r.connect();
    r.say({ type: "resize", width: 1180, height: 820 });
    r.say(TAP);
    await flush();
    r.drop();
    r.say({ type: "resize", width: 820, height: 1180 });
    r.connect();
    await flush();
    expect(r.layout()).toEqual({ width: 820, height: 1180 });
  });
});
