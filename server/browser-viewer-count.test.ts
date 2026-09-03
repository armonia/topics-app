/**
 * @covers VIEWCNT-01
 */
import { test, expect } from "bun:test";
import { countSharedViewers, createViewerCountPublisher, isSharedViewer, type ViewerFlags } from "./browser-viewer-count";

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
