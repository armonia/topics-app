/**
 * La prova vera del passaggio di sessione, con un browser VERO.
 *
 * I test unitari di `browser-session-handoff.test.ts` dimostrano le regole
 * (fonde, non azzera, molla in tempo) contro uno store finto. Restano una
 * promessa finché nessuno verifica che quel file su disco diventi davvero una
 * sessione autenticata: `saveStorageState` e `loadStorageState` potrebbero non
 * parlarsi, il seme potrebbe non arrivare a `newContext`, il formato del
 * cookie potrebbe essere quello sbagliato. Qui la catena gira intera —
 * delegate nativo (finto, ma via il registry VERO) → merge → store su disco →
 * contesto Playwright vero → pagina vera che legge il cookie e dice se sei
 * dentro o fuori.
 *
 * L'UNICA gamba non coperta è quella objc, cioè `browser_pane_get_cookies` che
 * legge il `WKHTTPCookieStore` della WKWebView: non si può eseguire senza una
 * build nativa. Ma quella gamba non è nuova — è quella che
 * `browser_save_state` usa già oggi in produzione, e qui è al suo posto,
 * scriptata, che risponde nella forma esatta che il comando Rust restituisce.
 *
 * Corsia pesante (`bun run test:heavy`): avvia un vero Chromium, e nella suite
 * intera sotto carico un timeout che scatta direbbe «il passaggio è rotto»
 * quando il fatto è «la macchina era occupata». Stesso motivo di
 * browser-dom-cobrowse.test.ts.
 * @covers BROWSER-CHAT-01
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* DATA_DIR E' AMBIENTE CONDIVISO, e questo file lo scrive.
 *
 * `server/db.ts:17` risolve la cartella dati come `process.env.DATA_DIR ||
 * join(dataRoot, "data")`: l'ambiente vince sull'argomento esplicito. Bun
 * carica piu' file di test nello STESSO processo, quindi una scrittura non
 * restituita decide dove finisce il database di tutti i file caricati dopo.
 * Misurato il 21/08: due file lanciati insieme aprivano quattro volte lo
 * stesso db temporaneo di uno dei due, mentre da soli ne creavano di propri.
 * Qui la variabile serve davvero (non si passa da `initDatabase`), quindi si
 * RESTITUISCE invece di toglierla. */
const DATA_DIR_PRIMA = process.env.DATA_DIR;


const HEAVY = process.env.TOPICS_HEAVY_TESTS === "1";
const describeHeavy = HEAVY ? describe : describe.skip;

// DATA_DIR va messo PRIMA di importare browser-state-store: la sua BASE_DIR è
// una const di modulo, letta una volta sola al caricamento. Con un import
// statico il test scriverebbe nel data/ del repo.
const DATA = mkdtempSync(join(tmpdir(), "handoff-heavy-"));
process.env.DATA_DIR = join(DATA, "data");

const { createBrowserService } = await import("./browser-service");
const { seedSharedFromNative } = await import("./browser-session-handoff");
const { createNativeDelegateRegistry, nativeDelegateRegistry } = await import("./browser-native-delegate");
type StorageState = import("../shared/browser-login-state").StorageState;

/** Un sito che sa solo dire se ti riconosce. Il cookie `sid=BUONO` è il login. */
function startSite() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const sid = /(?:^|;\s*)sid=([^;]*)/.exec(req.headers.get("cookie") ?? "")?.[1];
      const stato = sid === "BUONO" ? "DENTRO" : "FUORI";
      return new Response(
        `<!doctype html><html><head><title>${stato}</title></head><body><h1 id="stato">${stato}</h1></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}

describeHeavy("passaggio di sessione nativa → condivisa (browser vero)", () => {
  let site: ReturnType<typeof startSite>;
  let origin: string;
  // UN SOLO servizio per il file. Tre `createBrowserService()` in fila
  // avviavano tre Chromium sulla stessa porta CDP (19222) e il secondo restava
  // appeso: un rosso che dice «il passaggio è rotto» quando il fatto è «la
  // porta era occupata». Il confinamento fra i casi lo dà il contextId.
  let svc: Awaited<ReturnType<typeof createBrowserService>>;

  beforeAll(async () => {
    site = startSite();
    origin = `http://127.0.0.1:${site.port}`;
    // Porta CDP DEDICATA. Il default (19222) è condiviso con ogni altro
    // BrowserService: un Chromium rimasto in giro da un'altra corsa se la
    // teneva e questo file andava in timeout a 60s dicendo «il passaggio è
    // rotto» quando il fatto era «la porta era occupata».
    svc = await createBrowserService({ cdpPort: 19871 });
  });
  afterAll(async () => {
    await svc?.close?.().catch?.(() => {});
    site?.stop(true);
    rmSync(DATA, { recursive: true, force: true });
  });

  /** Il barattolo che la WKWebView restituirebbe: forma di `browser_pane_get_cookies`. */
  const nativeJar = (): StorageState => ({
    cookies: [{ name: "sid", value: "BUONO", domain: "127.0.0.1", path: "/", expires: -1 }],
    origins: [],
  });

  /** Registry VERO con la pane nativa scriptata sopra. */
  function nativePane(ctx: string, state: StorageState | null) {
    const registry = createNativeDelegateRegistry();
    if (state) {
      registry.register(ctx, (msg) => {
        queueMicrotask(() => registry.resolveOp({ opId: msg.opId, result: state }));
      });
    }
    return registry;
  }

  test("senza passaggio la sessione condivisa nasce SLOGGATA (il reperto)", async () => {
    const ctx = "handoff-controllo";
    try {
      // Nessuna pane nativa registrata: è il comportamento di oggi.
      const out = await seedSharedFromNative(ctx, { registry: nativePane(ctx, null) });
      expect(out).toEqual({ ok: false, skipped: "no-native-pane" });

      await svc.createContext(ctx);
      const r = await svc.navigate(ctx, origin);
      // Questo è il bug, misurato: il login nativo non attraversa il flip.
      expect(r.title).toBe("FUORI");
    } finally {
      await svc.destroyContext(ctx).catch(() => {});
    }
  }, 60_000);

  test("col passaggio la sessione condivisa nasce LOGGATA", async () => {
    const ctx = "handoff-vero";
    try {
      const out = await seedSharedFromNative(ctx, { registry: nativePane(ctx, nativeJar()) });
      expect(out).toEqual({ ok: true, cookies: 1, origins: 0 });

      // createContext legge il seme dallo store e lo passa a newContext.
      await svc.createContext(ctx);
      const r = await svc.navigate(ctx, origin);
      expect(r.title).toBe("DENTRO");
      // E il cookie è davvero nel barattolo del contesto, non solo nel titolo.
      const visto = await svc.evaluate(ctx, "document.cookie");
      expect(String(visto)).toContain("sid=BUONO");
    } finally {
      await svc.destroyContext(ctx).catch(() => {});
    }
  }, 60_000);

  test("createContext lo fa DA SÉ: basta una pane nativa viva sul contesto", async () => {
    // Gli altri casi chiamano seedSharedFromNative a mano, quindi dimostrano la
    // funzione ma NON che browser-service la chiami: togliendo la riga dal
    // servizio resterebbero tutti verdi. Qui non la chiama nessuno — si
    // registra la pane nativa sul registry di PRODUZIONE (quello che il
    // servizio usa di suo) e si guarda solo se il contesto nasce loggato.
    const ctx = "handoff-cablaggio";
    nativeDelegateRegistry.register(ctx, (msg) => {
      queueMicrotask(() =>
        nativeDelegateRegistry.resolveOp({ opId: msg.opId, result: nativeJar() }),
      );
    });
    try {
      await svc.createContext(ctx);
      const r = await svc.navigate(ctx, origin);
      expect(r.title).toBe("DENTRO");
    } finally {
      nativeDelegateRegistry.unregister(ctx);
      await svc.destroyContext(ctx).catch(() => {});
    }
  }, 60_000);

  test("il passaggio non slogga chi era già dentro sulla sessione condivisa", async () => {
    const ctx = "handoff-convivenza";
    try {
      // Il telefono si è loggato sulla sessione condivisa su un ALTRO sito.
      const { saveStorageState } = await import("./browser-state-store");
      await saveStorageState(ctx, {
        cookies: [{ name: "sid", value: "TELEFONO", domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
        origins: [],
      } as never);

      await seedSharedFromNative(ctx, { registry: nativePane(ctx, nativeJar()) });
      await svc.createContext(ctx);

      // Il cookie del Mac è arrivato...
      const r = await svc.navigate(ctx, origin);
      expect(r.title).toBe("DENTRO");
      // ...e quello del telefono, su un host diverso, è ancora lì.
      const suLocalhost = await svc.navigate(ctx, `http://localhost:${site.port}`);
      expect(suLocalhost.title).toBe("FUORI"); // valore TELEFONO ≠ BUONO: il cookie c'è, il login è un altro
      const visto = await svc.evaluate(ctx, "document.cookie");
      expect(String(visto)).toContain("sid=TELEFONO");
    } finally {
      await svc.destroyContext(ctx).catch(() => {});
    }
  }, 60_000);
});

afterAll(() => {
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
