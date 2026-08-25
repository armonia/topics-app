/**
 * @covers VIEWCNT-01
 */
import { test, expect } from "bun:test";
import { countSharedViewers, isSharedViewer, type ViewerFlags } from "./browser-viewer-count";

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
