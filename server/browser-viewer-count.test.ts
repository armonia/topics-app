/**
 * @covers VIEWCNT-01
 */
import { test, expect } from "bun:test";
import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countSharedViewers, createViewerCountPublisher, hasAttachedPane, isSharedViewer, type ViewerFlags } from "./browser-viewer-count";
import { upgradeWebSocket } from "./lib/ws-upgrade";
import type { WSData } from "./types";
import { startNativeExecutorSocket } from "../client/src/hooks/nativeExecutorSocket";

const sockets = (...datas: ViewerFlags[]) => datas.map((data) => ({ data }));

test("un delegato nativo non è uno spettatore, qualunque cosa dica", () => {
  expect(isSharedViewer({ _nativeDelegate: true })).toBe(false);
  expect(isSharedViewer({ _nativeDelegate: true, _watching: true })).toBe(false);
});

test("assente ⇒ spettatore (client vecchio o socket dell'agente)", () => {
  expect(isSharedViewer({})).toBe(true);
  expect(countSharedViewers(sockets({}, {}))).toBe(2);
});

test("fuori dallo schermo non conta; dentro sì", () => {
  expect(isSharedViewer({ _watching: false })).toBe(false);
  expect(isSharedViewer({ _watching: true })).toBe(true);
});

// Il motivo per cui `set_stream` NON è il segnale: il transport di default è
// WebRTC, che mette in pausa lo screencast pur guardando. Qui quello stato non
// esiste proprio — un telefono che guarda è contato comunque.
test("un telefono che guarda via WebRTC è contato", () => {
  expect(countSharedViewers(sockets({ _watching: true }))).toBe(1);
});

test("il caso vero: Mac nativo + telefono che guarda = 1 altro dispositivo", () => {
  const n = countSharedViewers(sockets({ _nativeDelegate: true }, { _watching: true }));
  expect(n).toBe(1);
});

test("Mac condiviso ma in secondo piano + telefono che guarda = 1", () => {
  // Il Mac esce dal conteggio da solo: è per questo che `computeAutoShared` non
  // deve sottrarsi (client/src/lib/sharedAuto.ts) — sennò 1 diventa 0 e rimbalza.
  const n = countSharedViewers(sockets({ _watching: false }, { _watching: true }));
  expect(n).toBe(1);
});

test("nessun socket ⇒ 0", () => {
  expect(countSharedViewers(undefined)).toBe(0);
  expect(countSharedViewers([])).toBe(0);
});

// The count is PUSHED to the panes instead of being polled every 2s: on the
// live log `GET /api/browsers/:id/viewers` was 44% of all API requests. The
// publisher sends only when the value changes, because the reaper calls it
// for every context on every tick.
test("a change is published once, a non-change never", () => {
  const counts = new Map<string, number>([["c1", 1]]);
  const sent: Array<[string, number]> = [];
  const pub = createViewerCountPublisher((c) => counts.get(c) ?? 0, (c, n) => sent.push([c, n]));

  expect(pub.publish("c1")).toBe(1);
  expect(pub.publish("c1")).toBeNull();
  expect(pub.publish("c1")).toBeNull();
  expect(sent).toEqual([["c1", 1]]);

  counts.set("c1", 2);
  expect(pub.publish("c1")).toBe(2);
  counts.set("c1", 0);
  expect(pub.publish("c1")).toBe(0);
  expect(sent).toEqual([["c1", 1], ["c1", 2], ["c1", 0]]);
  expect(pub.last("c1")).toBe(0);
});

test("once a context is forgotten, the same value is news again", () => {
  const sent: number[] = [];
  const pub = createViewerCountPublisher(() => 1, (_c, n) => sent.push(n));
  pub.publish("c1");
  pub.forget("c1");
  expect(pub.last("c1")).toBeUndefined();
  expect(pub.publish("c1")).toBe(1);
  expect(sent).toEqual([1, 1]);
});

test("contexts do not mix", () => {
  const sent: Array<[string, number]> = [];
  const pub = createViewerCountPublisher(() => 1, (c, n) => sent.push([c, n]));
  pub.publish("a");
  pub.publish("b");
  expect(sent).toEqual([["a", 1], ["b", 1]]);
});

test("chi entra non e' nel numero che gli si dice: la pane nativa non conta se stessa", () => {
  const me = { data: {} };
  const other = { data: { _watching: true } };
  expect(countSharedViewers([me, other], me)).toBe(1);
  expect(countSharedViewers([me], me)).toBe(0);
  expect(countSharedViewers([me, other])).toBe(2);
});

test("publish(ctx, except) passa il socket escluso a chi spedisce", () => {
  const sent: Array<{ ctx: string; n: number; except: unknown }> = [];
  const pub = createViewerCountPublisher(() => 3, (ctx, n, except) => { sent.push({ ctx, n, except }); });
  const me = { data: {} };
  expect(pub.publish("c1", me)).toBe(3);
  expect(sent).toEqual([{ ctx: "c1", n: 3, except: me }]);
  expect(pub.publish("c1")).toBeNull();
});

/**
 * `open_browser_pane` waits for a pane to attach, then navigates the context
 * (server/routes/browser-open-pane-flow.ts). A native pane takes that
 * navigation only once it is the context's executor, i.e. after the server
 * handled its `register_native_executor` frame. Seen on 25/09, 60 ms after a
 * pane reconnected: a call that lands between the socket's open and that frame
 * drove a headless context instead, and on a machine with no Chromium the
 * route answered `500 launch: Failed to launch chromium`.
 *
 * The sockets here are what the server really holds: the URL is the one the
 * native pane's executor socket opens, stamped by the same upgrade the request
 * path runs.
 */
function serverSocketFor(url: string): { readyState: number; data: WSData } {
  let data: WSData | undefined;
  const server = {
    upgrade: (_req: Request, opts: { data: WSData }) => { data = opts.data; return true; },
  } as unknown as Pick<Server<WSData>, "upgrade">;
  const { pathname } = new URL(url);
  expect(upgradeWebSocket(new Request(url.replace(/^ws/, "http")), pathname, server, null, false)).toBeUndefined();
  if (!data) throw new Error("the upgrade did not stamp the socket");
  return { readyState: 1, data };
}

/** The URL the native pane's executor socket opens for `paneUrl`. */
function nativeExecutorUrl(paneUrl: string): string {
  let opened = "";
  const run = startNativeExecutorSocket({
    url: paneUrl,
    createSocket: (url) => { opened = url; return { send() {}, close() {} }; },
    runOp: async () => ({}),
    onAgentActive: () => {},
  });
  run.stop();
  return opened;
}

const PANE_URL = "ws://127.0.0.1:3333/ws/browser/ctx-1?client=pane-a";

test("a native pane attaches when it registers as the executor, not when its socket opens", () => {
  const pane = serverSocketFor(nativeExecutorUrl(PANE_URL));
  expect(hasAttachedPane([pane]), "open but not registered: the navigation would go to a headless context").toBe(false);
  pane.data._nativeDelegate = true;
  expect(hasAttachedPane([pane])).toBe(true);
});

test("a web pane attaches as soon as its socket opens: it never registers", () => {
  expect(hasAttachedPane([serverSocketFor(PANE_URL)])).toBe(true);
});

test("a native pane still registering does not hide a web pane already attached", () => {
  const native = serverSocketFor(nativeExecutorUrl(PANE_URL));
  const web = serverSocketFor("ws://127.0.0.1:3333/ws/browser/ctx-1?client=pane-b");
  expect(hasAttachedPane([native, web])).toBe(true);
});

test("a socket that is no longer open attaches nothing, and no socket attaches nothing", () => {
  const pane = serverSocketFor(PANE_URL);
  pane.readyState = 3;
  expect(hasAttachedPane([pane])).toBe(false);
  expect(hasAttachedPane(undefined)).toBe(false);
});

/**
 * server.ts reads the executor flag in two places, and no unit test can import
 * it. Each line was reverted on 27/09 with every behavioural test still green:
 * the predicate the open-pane route polls, and the deferred screencast start a
 * flagged socket skips (its register frame often lands after the 250 ms grace,
 * and the start would then launch a headless Chromium for a pane that never
 * views frames).
 */
test("server.ts polls this predicate for open-pane, and never starts the screencast for an executor socket", () => {
  const code = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const wired = [
    "const paneAttachedTo = (contextId: string): boolean => hasAttachedPane(browserWsClients.get(contextId));",
    "createTopicsRouter(ctx, browserService, paneAttachedTo,",
    "if (screencastCancelled || !streamActive || ws.data.expectsExecutor) return;",
  ];
  for (const line of wired) expect(code.includes(line), `not wired any more: \`${line}\``).toBe(true);
});
