import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { RELOAD_FLASH_KEY, markReloadFlash, consumeReloadFlash } from "./reloadFlash";

/**
 * Il segno di «ha ricaricato» ha due proprietà che contano, e una terza che è
 * la vera trappola:
 *  1. si consuma — un toast per reload, non uno per ogni montaggio;
 *  2. non parla se nessuno l'ha messo — un reload NON chiesto (crash del
 *     WebContent) non deve fingere di essere stato un ⌘R;
 *  3. la chiave è la STESSA che scrive il guscio nativo. Chi mette il segno
 *     quasi sempre è Rust (⌘R intercettato dal monitor NSEvent, menu Reload,
 *     app_reload_all): se le due stringhe divergono, tutto compila, tutto gira,
 *     e il toast semplicemente non appare mai — il silenzio è esattamente il
 *     difetto che questo codice esiste per togliere.
 */

const LIB_RS = new URL(
  "../../../desktop-tauri/src-tauri/src/lib.rs",
  import.meta.url,
).pathname;

let store: Record<string, string>;
const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

function installStorage(impl: object) {
  Object.defineProperty(globalThis, "sessionStorage", { value: impl, configurable: true });
}

beforeEach(() => {
  store = {};
  installStorage({
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});

afterEach(() => {
  if (realSessionStorage) Object.defineProperty(globalThis, "sessionStorage", realSessionStorage);
  else delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe("reloadFlash", () => {
  test("senza segno non parla", () => {
    expect(consumeReloadFlash()).toBe(false);
  });

  test("il segno vale UNA volta sola", () => {
    markReloadFlash();
    expect(consumeReloadFlash()).toBe(true);
    expect(consumeReloadFlash()).toBe(false);
  });

  test("consumare svuota davvero lo storage", () => {
    markReloadFlash();
    expect(store[RELOAD_FLASH_KEY]).toBe("1");
    consumeReloadFlash();
    expect(RELOAD_FLASH_KEY in store).toBe(false);
  });

  test("storage negato: non lancia, semplicemente non annuncia", () => {
    installStorage({
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    });
    expect(() => markReloadFlash()).not.toThrow();
    expect(consumeReloadFlash()).toBe(false);
  });

  test("la chiave è la stessa che scrive il guscio nativo (lib.rs)", () => {
    const rs = readFileSync(LIB_RS, "utf8");
    const decl = rs.match(/const RELOAD_WITH_FLASH_JS: &str =\s*"([^"]+)"/);
    expect(decl).not.toBeNull();
    const js = decl![1];
    expect(js).toContain(`sessionStorage.setItem('${RELOAD_FLASH_KEY}'`);
    // E ricarica davvero: il segno senza il reload sarebbe un toast bugiardo.
    expect(js).toContain("window.location.reload()");
  });

  test("i tre reload CHIESTI dall'utente passano dalla costante", () => {
    const rs = readFileSync(LIB_RS, "utf8");
    // ⌘R (monitor NSEvent, con il suo fallback su "main"), la voce Reload/Force
    // Reload del menu, e app_reload_all: quattro usi, tre gesti.
    const uses = rs.match(/eval\(RELOAD_WITH_FLASH_JS\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  test("solo il nudge di cold-start ricarica in silenzio", () => {
    const rs = readFileSync(LIB_RS, "utf8");
    // NB: non è una `eval()` JavaScript — è la stringa sorgente Rust di
    // `WebviewWindow::eval`, cercata con una regex per scoprire i reload
    // scritti a mano. Un reload muto in più è il difetto che rientra dalla
    // finestra; questo UNO è voluto: l'upstream è appena salito e il client
    // non ha chiesto niente, quindi non c'è nessun «hai premuto» da confermare.
    const raw = rs.match(/eval\("[^"]*location\.reload\(\)[^"]*"\)/g) ?? [];
    expect(raw.length).toBe(1);
  });
});
