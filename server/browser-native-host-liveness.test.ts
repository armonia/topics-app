import { describe, expect, test } from "bun:test";
import { createNativeHostLiveness, HOST_PING_INTERVAL_MS, HOST_PONG_TIMEOUT_MS, type NativeHostSocket } from "./browser-native-host-liveness";
import { createHostMirror, type MirrorSocket } from "./browser-host-mirror";
import { createDomHostRegistry } from "./lib/native-dom-host";

/** @covers NATIVE-HOST-07 */

class Clock {
  now = 0;
  jobs: { at: number; fn: () => void; live: boolean }[] = [];
  schedule = (fn: () => void, ms: number) => {
    const job = { at: this.now + ms, fn, live: true };
    this.jobs.push(job);
    return () => { job.live = false; };
  };
  advance(ms: number) {
    const end = this.now + ms;
    while (true) {
      const next = this.jobs.filter((job) => job.live && job.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      this.now = next.at;
      next.fn();
    }
    this.now = end;
  }
}

class Socket implements NativeHostSocket {
  readyState = 1;
  sent: string[] = [];
  send(text: string) { this.sent.push(text); }
  types() { return this.sent.map((text) => JSON.parse(text).type as string); }
}

class MirrorSocketFake implements NativeHostSocket, MirrorSocket {
  readyState = 1;
  data: MirrorSocket["data"] = {};
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close(code: number, reason: string) { this.closed = { code, reason }; }
}

describe("native host application liveness", () => {
  test("a responding executor gets pings every five seconds and loss at fifteen seconds", () => {
    const clock = new Clock();
    const lost: string[] = [];
    const socket = new Socket();
    const liveness = createNativeHostLiveness({ now: () => clock.now, schedule: clock.schedule, onLost: (ctx) => lost.push(ctx) });
    liveness.register("ctx", socket);
    clock.advance(HOST_PING_INTERVAL_MS);
    expect(socket.types()).toEqual(["host_ping"]);
    liveness.pong(socket);
    clock.advance(HOST_PING_INTERVAL_MS);
    liveness.pong(socket);
    clock.advance(HOST_PONG_TIMEOUT_MS);
    expect(lost).toEqual(["ctx"]);
    expect(liveness.size()).toBe(0);
  });

  test("an old executor that never answers keeps the ninety-second protocol timeout", () => {
    const clock = new Clock();
    const lost: string[] = [];
    const socket = new Socket();
    const liveness = createNativeHostLiveness({ now: () => clock.now, schedule: clock.schedule, onLost: (ctx) => lost.push(ctx) });
    liveness.register("ctx", socket);
    clock.advance(HOST_PING_INTERVAL_MS * 4);
    expect(socket.types()).toEqual(["host_ping", "host_ping", "host_ping", "host_ping"]);
    clock.advance(90_000 - HOST_PING_INTERVAL_MS * 4);
    expect(lost).toEqual([]);
    expect(liveness.size()).toBe(1);
  });

  test("the only timer is canceled after the final executor unregisters", () => {
    const clock = new Clock();
    const socket = new Socket();
    const liveness = createNativeHostLiveness({ now: () => clock.now, schedule: clock.schedule, onLost: () => {} });
    liveness.register("ctx", socket);
    liveness.unregister(socket);
    clock.advance(HOST_PING_INTERVAL_MS * 2);
    expect(socket.types()).toEqual([]);
  });

  test("a pong timeout withdraws the host and warns its viewers within sixteen seconds", () => {
    const clock = new Clock();
    const sockets = new Set<MirrorSocketFake>();
    const hosts = createDomHostRegistry();
    const mirror = createHostMirror({
      hosts,
      sockets: () => sockets,
      browser: {
        enableDomMode: async () => [],
        destroyContext: async () => {},
        navigate: async (_contextId, url) => ({ url, title: "" }),
      },
      schedule: clock.schedule,
      now: () => clock.now,
    });
    const host = new MirrorSocketFake();
    host.data._nativeDelegate = true;
    sockets.add(host);
    mirror.onHostFrame(host, "ctx", { type: "native_dom_host" });
    mirror.onHostFrame(host, "ctx", { type: "host_page", url: "https://example.test" });
    const viewer = new MirrorSocketFake();
    sockets.add(viewer);
    mirror.routeViewer(viewer, "ctx", { type: "set_render", mode: "dom" });

    const liveness = createNativeHostLiveness<MirrorSocketFake>({
      now: () => clock.now,
      schedule: clock.schedule,
      onLost: (contextId, socket) => {
        sockets.delete(socket);
        mirror.onClose(socket, contextId);
        socket.close(1001, "Native host unresponsive");
      },
    });
    liveness.register("ctx", host);
    clock.advance(HOST_PING_INTERVAL_MS);
    liveness.pong(host);
    clock.advance(HOST_PING_INTERVAL_MS);
    liveness.pong(host);
    clock.advance(HOST_PONG_TIMEOUT_MS - 1);
    expect(viewer.sent.some((message) => message.type === "host_away")).toBe(false);
    expect(host.closed).toBeNull();

    clock.advance(1);
    expect(clock.now).toBe(25_000);
    expect(viewer.sent).toContainEqual({ type: "host_away" });
    expect(hosts.isHosting("ctx")).toBe(false);
    expect(host.closed).toEqual({ code: 1001, reason: "Native host unresponsive" });
    expect(liveness.size()).toBe(0);
  });
});
