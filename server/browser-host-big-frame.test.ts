import { afterEach, describe, expect, it } from "bun:test";
import { BrowserWsChunkAssembler, chunkText } from "../shared/browser-ws-chunks";
import { createHostMirror, type MirrorSocket } from "./browser-host-mirror";
import { createDomHostRegistry } from "./lib/native-dom-host";
import { WS_TRANSPORT_OPTIONS } from "./lib/websocket-options";

/** @covers NATIVE-HOST-05 */
describe("native DOM mirror large snapshots", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  it("relays a 4.8 MB FullSnapshot in bounded compressed frames", async () => {
    const hosts = createDomHostRegistry();
    const sockets = new Set<MirrorSocket>();
    let compressedFrames = 0;
    let oversizedFrames = 0;
    let mirrorChunkFrames = 0;
    let uncompressedMirrorChunkFrames = 0;
    const mirror = createHostMirror({
      hosts,
      sockets: () => sockets,
      browser: { enableDomMode: async () => null, destroyContext: async () => {}, navigate: async () => ({ url: "", title: "" }) },
    });
    const server = Bun.serve<{ role: "host" | "viewer"; remote: boolean }>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, instance) {
        const role = new URL(req.url).pathname.slice(1) as "host" | "viewer";
        if (role !== "host" && role !== "viewer") return new Response("not found", { status: 404 });
        if (instance.upgrade(req, { data: { role, remote: true } })) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        ...WS_TRANSPORT_OPTIONS,
        open(ws) {
          const socket: MirrorSocket = {
            readyState: 1,
            data: { id: ws.data.role, remote: true, _nativeDelegate: ws.data.role === "host", _domRender: false, _watching: true },
            send(text, compress) {
              const bytes = new TextEncoder().encode(text).byteLength;
              if (bytes >= 512 * 1024) oversizedFrames++;
              if (compress) compressedFrames++;
              if (JSON.parse(text).type === "dom_event_chunk") {
                mirrorChunkFrames++;
                if (!compress) uncompressedMirrorChunkFrames++;
              }
              return ws.send(text, compress);
            },
          };
          sockets.add(socket);
          if (ws.data.role === "host") mirror.onHostFrame(socket, "ctx", { type: "native_dom_host" });
          else mirror.attachIfIdle(socket, "ctx");
          (ws.data as typeof ws.data & { mirrorSocket: MirrorSocket }).mirrorSocket = socket;
        },
        message(ws, raw) {
          const socket = (ws.data as typeof ws.data & { mirrorSocket: MirrorSocket }).mirrorSocket;
          if (ws.data.role === "host") {
            const frame = JSON.parse(String(raw)) as { id: string; index: number; total: number; data: string };
            mirror.onHostFrame(socket, "ctx", { type: "host_dom_events_chunk", ...frame });
          }
        },
        close(ws) {
          const socket = (ws.data as typeof ws.data & { mirrorSocket?: MirrorSocket }).mirrorSocket;
          if (socket) { sockets.delete(socket); mirror.onClose(socket, "ctx"); }
        },
      },
    });
    stop = () => server.stop(true);

    const connect = async (role: "host" | "viewer"): Promise<WebSocket> => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/${role}`);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`${role} connection failed`)), { once: true });
      });
      return socket;
    };
    const host = await connect("host");
    let viewer = await connect("viewer");

    const snapshot = { type: 2, timestamp: 1, data: { node: { type: 3, id: 1, textContent: "x".repeat(4_800_000) } } };
    const original = JSON.stringify([snapshot]);
    const hostChunks = chunkText(original, "large-snapshot");
    const received = new BrowserWsChunkAssembler();
    let replayed: unknown;
    let completeSnapshot!: () => void;
    let failSnapshot!: (error: Error) => void;
    const allFrames = new Promise<void>((resolve, reject) => {
      completeSnapshot = resolve;
      failSnapshot = reject;
    });
    const onViewerMessage = (event: MessageEvent): void => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; id?: string; index?: number; total?: number; data?: string };
        if (frame.type !== "dom_event_chunk") return;
        const text = received.add(frame as { id: string; index: number; total: number; data: string });
        if (text !== null) {
          replayed = JSON.parse(text);
          completeSnapshot();
        }
      } catch (error) { failSnapshot(error instanceof Error ? error : new Error(String(error))); }
    };
    viewer.addEventListener("message", onViewerMessage);
    const timeout = setTimeout(() => failSnapshot(new Error("viewer did not receive the full snapshot")), 15_000);
    const startedAt = Date.now();
    for (let index = 0; index < hostChunks.length; index++) {
      if (index === 3) {
        const previousViewer = viewer;
        const closed = new Promise<void>((resolve) => previousViewer.addEventListener("close", () => resolve(), { once: true }));
        previousViewer.close();
        await closed;
        viewer = await connect("viewer");
        viewer.addEventListener("message", onViewerMessage);
      }
      const chunk = hostChunks[index]!;
      host.send(JSON.stringify({ type: "host_dom_events_chunk", ...chunk }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await allFrames;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2_000 - (Date.now() - startedAt))));
    clearTimeout(timeout);

    expect(host.readyState).toBe(WebSocket.OPEN);
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    expect((replayed as { type: string; event: unknown }).type).toBe("dom_event");
    expect((replayed as { event: unknown }).event).toEqual(snapshot);
    expect(hostChunks.every((chunk) => new TextEncoder().encode(JSON.stringify({ type: "host_dom_events_chunk", ...chunk })).byteLength < 512 * 1024)).toBe(true);
    expect(compressedFrames).toBeGreaterThan(0);
    expect(mirrorChunkFrames).toBeGreaterThan(0);
    expect(uncompressedMirrorChunkFrames).toBe(0);
    expect(oversizedFrames).toBe(0);
    host.close();
    viewer.close();
  });
});
