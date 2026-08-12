import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { RELOAD_FLASH_KEY, markReloadFlash, consumeReloadFlash } from "./reloadFlash";
import { findReloadSites, countByOwner, codeOnlyLines } from "./reloadSites";

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

const RUST_SRC = new URL("../../../desktop-tauri/src-tauri/src/", import.meta.url).pathname;
const LIB_RS = `${RUST_SRC}lib.rs`;

/** Tutto il sorgente del guscio, non solo `lib.rs`: un reload scritto in un file
 *  nuovo non deve poter nascere fuori dal campo visivo della guardia. */
const RUST_SOURCES = readdirSync(RUST_SRC)
  .filter((f) => f.endsWith(".rs"))
  .sort()
  .map((file) => ({ file, source: readFileSync(RUST_SRC + file, "utf8") }));

type Kind = "silent" | "announced" | "self-limiting";

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

  test("i tre reload CHIESTI dall'utente passano dalla STESSA funzione", () => {
    const rs = readFileSync(LIB_RS, "utf8");
    // ⌘R intercettato dal monitor NSEvent, la voce Reload/Force Reload del menu,
    // e il comando app_reload_all sono TRE PORTE SULLO STESSO GESTO: «riparti».
    // Devono avere una semantica sola — ricaricare tutte le finestre UI — e il
    // solo modo di garantirlo è che chiamino la stessa funzione. Quando erano
    // tre implementazioni, il monitor ingoiava ⌘R (`return nil`) e ricaricava la
    // sola finestra dell'evento: i gruppi staccati restavano sul bundle vecchio,
    // due versioni dello stesso client sullo stesso pane-store.
    expect(rs).toContain("fn reload_all_ui_windows(");
    const calls = rs.match(/reload_all_ui_windows\(&?app\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // …e il segno lo mette LEI, in un punto solo: una seconda `eval` della
    // costante sarebbe una quarta semantica che rientra dalla finestra.
    const uses = rs.match(/eval\(RELOAD_WITH_FLASH_JS\)/g) ?? [];
    expect(uses.length).toBe(1);
  });

  test("ogni reload del guscio nativo è dichiarato, e uno solo è silenzioso", () => {
    // La versione precedente di questa guardia cercava `eval("…reload()…")`:
    // una FORMA. Quando il recupero-finestra ha spostato la chiamata dentro
    // `eval_in_main_webview(&h, …)` la forma è sparita e la regex ha smesso di
    // trovare qualsiasi cosa — guardia muta, difetto libero di rientrare. Qui
    // si parte dal fatto che non si può aggirare scrivendo diversamente («in
    // questo sorgente c'è `location.reload()`») e si obbliga chi ne aggiunge
    // uno a dichiararlo QUI, in una delle tre categorie:
    //
    //  · silent        — parte senza gesto dell'utente, non lascia segno e
    //                    ricarica quello che c'è. Butta via una sessione viva:
    //                    ne esiste UNO SOLO, e solo perché al cold start non
    //                    c'è ancora niente da buttare via.
    //  · announced     — l'utente l'ha chiesto e il client glielo conferma
    //                    (il toast «Ricaricata»): un reload identico allo
    //                    schermo di prima, senza segno, si legge come «non va».
    //  · self-limiting — ricarica solo un documento che non ha niente da
    //                    perdere (`#root` vuoto, o la pagina che il guscio
    //                    stesso serve al posto di una navigazione morta).
    //
    // Alzare un numero qui sotto per far passare la suite è il modo veloce di
    // trasformare la guardia in un ornamento: il numero è una conseguenza, la
    // categoria è la decisione.
    const DECLARED: Record<string, { kind: Kind; count: number }> = {
      COLD_START_RELOAD_JS: { kind: "silent", count: 1 },
      RELOAD_WITH_FLASH_JS: { kind: "announced", count: 1 },
      // due volte: il `try` e il `catch` — se non riusciamo nemmeno a guardare
      // il DOM, quel documento non è in uno stato che valga la pena tenere.
      RELOAD_IF_BLANK_JS: { kind: "self-limiting", count: 2 },
      reconnect_page_response: { kind: "self-limiting", count: 1 },
    };

    const sites = RUST_SOURCES.flatMap(({ file, source }) => findReloadSites(file, source));
    // Esaustività: nessun sito fuori dalla tabella. Un reload nuovo, scritto in
    // qualunque modo e in qualunque file del guscio, atterra qui.
    const undeclared = sites
      .filter((s) => !(s.owner in DECLARED))
      .map((s) => `${s.file}:${s.line} in ${s.owner}`);
    expect(undeclared).toEqual([]);
    // …e nessuno che si nasconde dentro un owner già noto alzandone il conto.
    const expectedCounts = Object.fromEntries(
      Object.entries(DECLARED).map(([owner, d]) => [owner, d.count]),
    );
    expect(countByOwner(sites)).toEqual(expectedCounts);

    const silent = Object.keys(DECLARED).filter((o) => DECLARED[o].kind === "silent");
    expect(silent).toEqual(["COLD_START_RELOAD_JS"]);
  });

  test("il reload silenzioso ha un grilletto solo", () => {
    // Il conteggio dei siti non basta: la costante è dichiarata una volta ma
    // può essere sparata da dieci punti diversi, e sarebbero dieci reload muti
    // con un solo `location.reload()` scritto. Si contano gli USI.
    const lib = RUST_SOURCES.find((s) => s.file === "lib.rs")!;
    const uses = codeOnlyLines(lib.source)
      .filter((l) => !/^\s*(?:pub\s+)?const\s+COLD_START_RELOAD_JS\b/.test(l))
      .join("\n")
      .match(/\bCOLD_START_RELOAD_JS\b/g) ?? [];
    expect(uses.length).toBe(1);
  });
});
