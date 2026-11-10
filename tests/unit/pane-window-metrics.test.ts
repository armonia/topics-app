import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * @covers ANTIBOT-01
 */
// The pane init script (desktop-tauri/src-tauri/src/pane_window_metrics.js): a
// child WKWebView answers 0 to outerWidth/outerHeight and Heray (Hetzner's
// anti-bot) rejects the proof of work. This runs the file as shipped inside a
// context that imitates that engine.
const SRC = readFileSync(
  new URL("../../desktop-tauri/src-tauri/src/pane_window_metrics.js", import.meta.url),
  "utf8",
);

function paneWindow(real: { outerWidth: number; outerHeight: number }, inner = { w: 1425, h: 628 }) {
  const ctx = vm.createContext({});
  vm.runInContext("this.window = this;", ctx);
  const w = ctx as Record<string, unknown>;
  w.innerWidth = inner.w;
  w.innerHeight = inner.h;
  // Like WebKit: an own accessor on the instance, with get and set.
  let ow = real.outerWidth;
  let oh = real.outerHeight;
  Object.defineProperty(ctx, "outerWidth", { get: () => ow, set: (v) => { ow = v; }, configurable: true, enumerable: true });
  Object.defineProperty(ctx, "outerHeight", { get: () => oh, set: (v) => { oh = v; }, configurable: true, enumerable: true });
  vm.runInContext(SRC, ctx);
  return ctx;
}

describe("pane_window_metrics.js", () => {
  test("con 0 e 0 (il WKWebView figlio) la pagina vede la misura interna", () => {
    const ctx = paneWindow({ outerWidth: 0, outerHeight: 0 });
    expect(vm.runInContext("[outerWidth, outerHeight]", ctx)).toEqual([1425, 628]);
  });

  test("un valore già plausibile (fuori > dentro) resta quello vero", () => {
    const ctx = paneWindow({ outerWidth: 1440, outerHeight: 760 });
    expect(vm.runInContext("[outerWidth, outerHeight]", ctx)).toEqual([1440, 760]);
  });

  test("segue il ridimensionamento della pane", () => {
    const ctx = paneWindow({ outerWidth: 0, outerHeight: 0 });
    vm.runInContext("innerWidth = 800; innerHeight = 500;", ctx);
    expect(vm.runInContext("[outerWidth, outerHeight]", ctx)).toEqual([800, 500]);
  });

  test("lanciato due volte non si impila", () => {
    const ctx = paneWindow({ outerWidth: 0, outerHeight: 0 });
    vm.runInContext(SRC, ctx);
    expect(vm.runInContext("outerWidth", ctx)).toBe(1425);
  });

  test("la pagina può ancora sovrascriverlo (è [Replaceable])", () => {
    const ctx = paneWindow({ outerWidth: 0, outerHeight: 0 });
    expect(() => vm.runInContext("outerWidth = 2000", ctx)).not.toThrow();
    expect(vm.runInContext("outerWidth", ctx)).toBe(2000);
  });
});
