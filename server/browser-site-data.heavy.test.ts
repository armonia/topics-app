/**
 * «Dimentica questo sito» sulla pane condivisa, con un browser VERO.
 *
 * I test di `browser-site-data.test.ts` dimostrano le regole (come si nomina un
 * silo, cosa resta dopo un filtro) contro uno stato finto. Restano una promessa
 * finché nessuno verifica che quel filtro sloggi davvero: potrebbe non arrivare
 * al contesto acceso, `Storage.clearDataForOrigin` potrebbe volere un'altra
 * forma di origin, e soprattutto potrebbe cancellare il FILE lasciando
 * l'identità viva in RAM.
 *
 * È quest'ultimo il guasto che questo file esiste per prendere, ed è quello che
 * un test sullo stato finto non può vedere: l'autosave a 30s riscrive
 * `storage.json` a partire dal contesto vivo, quindi un comando che pulisce
 * solo il disco rimette il sito al suo posto mezzo minuto dopo, da solo. Qui il
 * salvataggio lo forziamo subito dopo la cancellazione (`flushStorageState`,
 * che è esattamente quello che fa l'autosave) e si guarda se il sito torna.
 *
 * Due siti sulla STESSA porta, `127.0.0.1` e `localhost`: sono due host veri e
 * quindi due silo distinti, ed è il modo più corto per provare anche l'altra
 * metà del patto, cioè che il vicino non lo si tocca.
 *
 * Corsia pesante (`bun run test:heavy`): avvia un vero Chromium. Stesso motivo
 * di browser-session-handoff.heavy.test.ts.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEAVY = process.env.TOPICS_HEAVY_TESTS === "1";
const describeHeavy = HEAVY ? describe : describe.skip;

// DATA_DIR va messo PRIMA di importare browser-state-store: la sua BASE_DIR è
// una const di modulo, letta una volta sola al caricamento.
//
// E va messo SOLO nella corsia pesante, dentro l'`if`. `process.env` è di tutto
// il processo, e `bun run test:unit` carica anche questo file — per saltarlo,
// ma caricarlo basta a eseguire quello che sta qui fuori. Spostare DATA_DIR
// mentre gli altri file lo leggono sposta il barattolo sotto ai loro piedi:
// `browser-state-store.test.ts` calcola la sua BASE_DIR proprio da lì, e si
// ritrovava a cercare in una cartella dove il modulo non stava più scrivendo.
// Sei suoi test rossi, e nessuno di questo file: il tipo di guasto che si
// incolpa a chiunque tranne che a chi l'ha fatto.
let DATA = "";
let createBrowserService!: (typeof import("./browser-service"))["createBrowserService"];
let loadStorageState!: (typeof import("./browser-state-store"))["loadStorageState"];
let siteDataRecords!: (typeof import("./browser-site-data"))["siteDataRecords"];

if (HEAVY) {
  DATA = mkdtempSync(join(tmpdir(), "site-data-heavy-"));
  process.env.DATA_DIR = join(DATA, "data");
  // `const { x } = await import(…)`, non `({ x } = await import(…))`. La seconda
  // forma è un'ASSEGNAZIONE, e knip sa leggere solo la dichiarazione
  // (`handleVariableDeclarator`, typescript/visitors/imports.js:5): tutto il
  // resto cade nel ramo generico che marca l'import OPACO, e un import opaco
  // rende «usato» ogni export di quel modulo — per sempre, senza un avviso.
  // Erano tre moduli ciechi in un colpo solo. Il ponte con le `let` di sopra
  // costa tre righe e le ricompra.
  const { createBrowserService: createService } = await import("./browser-service");
  const { loadStorageState: loadState } = await import("./browser-state-store");
  const { siteDataRecords: records } = await import("./browser-site-data");
  createBrowserService = createService;
  loadStorageState = loadState;
  siteDataRecords = records;
}

/** Un sito che dice se ti riconosce, e che al `/login` ti dà il cookie. */
function startSite() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const sid = /(?:^|;\s*)sid=([^;]*)/.exec(req.headers.get("cookie") ?? "")?.[1];
      const stato = sid === "BUONO" ? "DENTRO" : "FUORI";
      const headers: Record<string, string> = { "content-type": "text/html" };
      if (url.pathname === "/login") headers["set-cookie"] = "sid=BUONO; Path=/";
      return new Response(
        `<!doctype html><html><head><title>${stato}</title></head><body><h1>${stato}</h1></body></html>`,
        { headers },
      );
    },
  });
}

/** Scrive localStorage e un IndexedDB con dentro qualcosa: uno store vuoto
 *  potrebbe non finire nello storageState, e il test misurerebbe niente. */
const SCRIVI_STORAGE = `(async function(){
  localStorage.setItem('nota', 'bozza');
  await new Promise(function(res, rej){
    var r = indexedDB.open('appunti', 1);
    r.onupgradeneeded = function(){ r.result.createObjectStore('s'); };
    r.onsuccess = function(){
      var db = r.result;
      var tx = db.transaction('s', 'readwrite');
      tx.objectStore('s').put('valore', 'chiave');
      tx.oncomplete = function(){ db.close(); res(null); };
      tx.onerror = function(){ db.close(); rej(tx.error); };
    };
    r.onerror = function(){ rej(r.error); };
  });
  return true;
})();`;

const LEGGI_NOTA = `localStorage.getItem('nota')`;

describeHeavy("dimentica un sito sulla pane condivisa (browser vero)", () => {
  let site: ReturnType<typeof startSite>;
  let casa: string;
  let vicino: string;
  let svc: Awaited<ReturnType<typeof createBrowserService>>;
  const ctx = "forget-site-heavy";

  beforeAll(async () => {
    site = startSite();
    // Stessa porta, due host: due silo veri senza un secondo server.
    casa = `http://127.0.0.1:${site.port}`;
    vicino = `http://localhost:${site.port}`;
    // Porta CDP DEDICATA: il default (19222) è condiviso con ogni altro
    // BrowserService, e un Chromium rimasto in giro da un'altra corsa
    // manderebbe questo file in timeout dicendo «il comando è rotto».
    svc = await createBrowserService({ cdpPort: 19872 });
    await svc.createContext(ctx);
    for (const origin of [casa, vicino]) {
      await svc.navigate(ctx, `${origin}/login`);
      await svc.evaluate(ctx, SCRIVI_STORAGE);
    }
    // Si finisce sul sito che stiamo per dimenticare: è il caso vero, ed è
    // anche il più difficile (il renderer tiene la sua copia di localStorage).
    await svc.navigate(ctx, casa);
  });

  afterAll(async () => {
    await svc?.destroyContext(ctx).catch(() => {});
    await svc?.close?.().catch?.(() => {});
    site?.stop(true);
    rmSync(DATA, { recursive: true, force: true });
  });

  test("l'elenco vede i due silo, coi tipi che ci sono davvero dentro", async () => {
    const { supported, records } = await svc.siteDataRecords(ctx);
    expect(supported).toBe(true);
    const nomi = records.map((r) => r.displayName).sort();
    expect(nomi).toEqual(["127.0.0.1", "localhost"]);
    const mio = records.find((r) => r.displayName === "127.0.0.1")!;
    expect(mio.types.sort()).toEqual(["cookies", "indexedDB", "localStorage"]);
    // E la cache non c'è, perché nel condiviso non è per-sito e il dialogo non
    // la promette.
    expect(mio.types.some((t) => t.toLowerCase().includes("cache"))).toBe(false);
  }, 90_000);

  test("dimenticato: il contesto VIVO non ti riconosce più, e il disco nemmeno", async () => {
    const out = await svc.forgetSite(ctx, ["127.0.0.1"]);
    expect(out).toEqual({ supported: true, removed: 1 });

    // 1. Il contesto acceso. Il cookie non parte più, quindi il sito risponde
    //    FUORI, e la nota non è più nel localStorage di quell'origine.
    const dopo = await svc.navigate(ctx, casa);
    expect(dopo.title).toBe("FUORI");
    expect(await svc.evaluate(ctx, LEGGI_NOTA)).toBeNull();

    // 2. Il file. Il silo non c'è più fra i record salvati.
    const suDisco = siteDataRecords(await loadStorageState(ctx));
    expect(suDisco.map((r) => r.displayName)).not.toContain("127.0.0.1");
  }, 90_000);

  test("IL PUNTO: l'autosave non lo resuscita", async () => {
    // `flushStorageState` è quello che fa l'autosave ogni 30 secondi: prende lo
    // stato del contesto VIVO e lo riscrive sul file. Se avessimo pulito solo
    // il disco, il sito tornerebbe qui.
    expect(await svc.flushStorageState(ctx)).toBe(true);
    const dopoAutosave = siteDataRecords(await loadStorageState(ctx));
    expect(dopoAutosave.map((r) => r.displayName)).not.toContain("127.0.0.1");
  }, 90_000);

  test("e il vicino di casa è rimasto dov'era", async () => {
    const r = await svc.navigate(ctx, vicino);
    expect(r.title).toBe("DENTRO");
    expect(await svc.evaluate(ctx, LEGGI_NOTA)).toBe("bozza");
    const records = await svc.siteDataRecords(ctx);
    expect(records.records.map((r2) => r2.displayName)).toContain("localhost");
  }, 90_000);
});
