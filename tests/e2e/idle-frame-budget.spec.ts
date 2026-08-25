/**
 * @covers IDLE-01
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp, openTestChat } from "./helpers";
import {
  createTerminalSession,
  deleteTerminalSession,
  seedPaneStore,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Budget di frame A RIPOSO.
 *
 * PERCHÉ ESISTE (2026-07-28). Profilando il renderer WebKit dell'app in
 * produzione (`sample` sul WebContent) il 79% dei campioni del main thread stava
 * in `updateRendering()` con l'app FERMA: nessuno stream, nessun input. Un rAF in
 * coda non costa "quasi niente" — obbliga WebKit a un rendering update completo
 * ogni frame, e lì dentro finiscono l'animatore del caret (che forza un layout
 * sincrono dell'intero documento) e il layout finale su un albero di flex
 * annidati. Due pompe trovate così: il ticker dell'aura, che si ri-armava
 * incondizionatamente (fixato: ora si parcheggia), e la catena
 * ResizeObserver→rAF→`offsetParent` di react-virtuoso.
 *
 * Il test misura il SINTOMO, non l'implementazione: quanti rAF e quante notifiche
 * di ResizeObserver arrivano in una finestra di quiete. È l'unico modo per
 * accorgersi di una regressione del genere PRIMA di ritrovarsela in un profilo
 * `sample` a mano, e non si lega a quale componente ha sbagliato.
 *
 * NON è un cap sugli FPS, ed è una distinzione che conta. Il frame rate alto non
 * è il problema — è l'obiettivo: mentre si scrolla o una chat streamma vogliamo
 * TUTTI i frame che il display concede. Il problema è chiedere frame quando non
 * c'è NIENTE da disegnare, e farci dentro un layout sincrono. Perciò la misura è
 * confinata a una finestra di QUIETE e il budget è largo: fallire qui vuol dire
 * "qualcosa gira a frame pieno mentre non succede niente", non "un frame di
 * troppo".
 */

/** Finestra di misura, ms. */
const WINDOW_MS = 3000;
/**
 * Soglia. A ~60Hz continui in WINDOW_MS si fanno ~180 rAF (su un pannello
 * ProMotion a 120Hz il doppio: motivo in più per non pompare a vuoto).
 *
 * La baseline NON è zero ed è voluta: `lib/fpsMonitor.ts` misura 400ms ogni 4.4s
 * per poter mostrare gli FPS in status bar — ~8% di duty cycle, cioè al massimo
 * due raffiche da ~24 frame dentro questa finestra. È l'unico consumatore
 * legittimo a riposo, e misurato vale 32-38 rAF. La soglia sta in mezzo fra
 * quella baseline e una pompa continua: sopra 90 qualcuno chiede un frame OGNI
 * frame mentre non succede niente.
 */
const MAX_RAF = 90;
/** Un observer che si assesta ne emette pochi; a frame pieno sono centinaia. */
const MAX_RESIZE_NOTIFICATIONS = 60;

interface FrameProbe {
  raf: number;
  resize: number;
  rafTop: [string, number][];
}

/**
 * Installa le sonde PRIMA del bundle: gli observer creati al boot devono passare
 * dal nostro wrapper, altrimenti li conteremmo a zero.
 */
async function installFrameProbe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __frameProbe: { raf: number; resize: number; sources: Record<string, number>; on: boolean };
      requestAnimationFrame: typeof requestAnimationFrame;
      ResizeObserver: typeof ResizeObserver;
    };
    w.__frameProbe = { raf: 0, resize: 0, sources: {}, on: false };

    const origRaf = w.requestAnimationFrame.bind(window);
    w.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      if (w.__frameProbe.on) {
        w.__frameProbe.raf += 1;
        // Due frame di stack sopra il wrapper = il chiamante reale. Serve a
        // dire QUALE modulo pompa, senza doverlo indovinare dal profilo nativo.
        const stack = (new Error().stack ?? "").split("\n").slice(1, 4).join(" | ");
        w.__frameProbe.sources[stack] = (w.__frameProbe.sources[stack] ?? 0) + 1;
      }
      return origRaf(cb);
    }) as typeof requestAnimationFrame;

    const OrigRO = w.ResizeObserver;
    if (OrigRO) {
      w.ResizeObserver = class extends OrigRO {
        constructor(cb: ResizeObserverCallback) {
          super((entries, obs) => {
            if (w.__frameProbe.on) w.__frameProbe.resize += entries.length;
            cb(entries, obs);
          });
        }
      } as typeof ResizeObserver;
    }
  });
}

/** Apre la finestra di misura e restituisce i conteggi. */
async function measureQuietWindow(page: Page): Promise<FrameProbe> {
  return page.evaluate(async (windowMs: number): Promise<FrameProbe> => {
    const w = window as unknown as {
      __frameProbe: { raf: number; resize: number; sources: Record<string, number>; on: boolean };
    };
    w.__frameProbe.raf = 0;
    w.__frameProbe.resize = 0;
    w.__frameProbe.sources = {};
    w.__frameProbe.on = true;
    await new Promise((r) => setTimeout(r, windowMs));
    w.__frameProbe.on = false;
    const rafTop = Object.entries(w.__frameProbe.sources)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5) as [string, number][];
    return { raf: w.__frameProbe.raf, resize: w.__frameProbe.resize, rafTop };
  }, WINDOW_MS);
}

/** Sempre stampato: quando fallisce, la prima riga di rafTop È la diagnosi. */
function reportAndAssert(label: string, probe: FrameProbe) {
  console.log(
    `[idle-frame-budget/${label}] rAF=${probe.raf} resize=${probe.resize} in ${WINDOW_MS}ms\n` +
      probe.rafTop.map(([src, n]) => `  ${n}× ${src}`).join("\n"),
  );
  expect(probe.raf, `rAF a riposo (top: ${probe.rafTop[0]?.[0] ?? "—"})`).toBeLessThan(MAX_RAF);
  expect(probe.resize, "notifiche ResizeObserver a riposo").toBeLessThan(MAX_RESIZE_NOTIFICATIONS);
}

test.describe("perf: app a riposo", () => {
  test("niente pompa di rAF/ResizeObserver quando non succede niente", async ({ page }) => {
    await installFrameProbe(page);
    await goToApp(page);
    // Boot, animazioni d'ingresso e primo assestamento del layout non contano.
    await page.waitForTimeout(2500);
    reportAndAssert("shell", await measureQuietWindow(page));
  });

  // La shell nuda non monta la lista virtualizzata, quindi da sola non
  // coprirebbe proprio il codice che ha bruciato il 26% del main thread: la
  // catena ResizeObserver→rAF→`offsetParent` di react-virtuoso vive nello
  // scroller della chat. Con una chat aperta e ferma quella catena deve
  // assestarsi e TACERE — se torna a battere a ogni frame, questo è il test che
  // se ne accorge.
  test("chat aperta e ferma: la lista virtualizzata si assesta e tace", async ({ page }) => {
    await installFrameProbe(page);
    await goToApp(page);
    await openTestChat(page);
    await page
      .locator("[data-testid='chat-scroll-container']")
      .waitFor({ state: "visible", timeout: 10000 });
    // La lista misura, si assesta e smette: le prime notifiche sono legittime.
    await page.waitForTimeout(2500);
    reportAndAssert("chat", await measureQuietWindow(page));
  });

  // Terzo caso, e quello che mancava: i timer PER PANE. Shell e chat non ne
  // montano nessuno; i poll, gli observer e i rAF del Tier 1 vivono nei
  // terminali e nelle pane browser. Un terminale FERMO — nessun output, nessun
  // input — non deve chiedere frame: xterm ridisegna solo quando arriva
  // qualcosa, e finché non arriva niente il pane deve tacere come tutto il
  // resto. Prima di questo caso, un IntersectionObserver per terminale e un
  // coalescer che si ri-armava a vuoto sarebbero passati inosservati.
  test("terminale aperto e fermo: nessun frame chiesto a vuoto", async ({ page, request }) => {
    const session = await createTerminalSession(request, { cwd: "/tmp", name: "idle-probe" });
    const paneId = `terminal:${session.id}`;
    try {
      await seedPaneStore(request, () => ({
        panes: {
          [paneId]: {
            id: paneId,
            type: "terminal",
            title: "idle-probe",
            terminalSessionId: session.id,
          },
        },
        groups: {
          "group:default": {
            id: "group:default",
            paneIds: [paneId],
            splitRatio: 1,
            splitAxis: "horizontal",
          },
        },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
      }));

      await installFrameProbe(page);
      await goToApp(page);
      await page.locator(".xterm-rows").first().waitFor({ state: "visible", timeout: 20000 });
      // Il prompt della shell arriva e si stampa: quel disegno è legittimo.
      // Si misura DOPO, quando non deve più succedere niente.
      await page.waitForTimeout(3000);
      reportAndAssert("terminale", await measureQuietWindow(page));
    } finally {
      await deleteTerminalSession(request, session.id);
    }
  });
});

/**
 * A FINESTRA NASCOSTA I DRAIN NATIVI DEVONO TACERE — E AL RITORNO RECUPERARE.
 *
 * I rAF qui sopra misurano il costo di chi DISEGNA. Questo misura il costo di
 * chi PARLA COL GUSCIO: `useTauriBrowser` arma cinque poll per pane browser, e
 * i due drain nativi (`browser_take_nav_state` a 250ms,
 * `browser_take_nav_errors` a 1s) fino al 2026-08-15 guardavano solo `ready`.
 * Con l'app in Cmd+H, minimizzata o su un altro Space continuavano a battere:
 * ~300 risvegli al minuto per pane, per zero pixel. E le pane native non si
 * sfrattano mai (`RESIDENCY_BUDGET.native` è `Infinity` per contratto), quindi
 * il conto non cala da solo.
 *
 * DUE METÀ, E LA SECONDA CONTA QUANTO LA PRIMA. Un poll che tace e basta si
 * scrive con un `return`; il patto di `startVisibilityGatedPoll` è che al
 * ritorno in primo piano ci sia un RECUPERO immediato, o la barra degli
 * indirizzi resterebbe indietro di un periodo intero. Il test misura entrambe.
 *
 * PERCHÉ NON MISURA I FRAME. Un'IPC verso il Rust non chiede un frame: non
 * comparirebbe nella sonda dei rAF nemmeno se battesse a 4Hz per venti pane. Si
 * conta la cosa vera, cioè le chiamate al ponte, stubbando `__TAURI_INTERNALS__`
 * con un contatore. Lo stub è anche l'UNICO modo di far prendere alla pane il
 * ramo nativo sotto Chromium (`isTauri` si decide su quel globale).
 *
 * PERCHÉ LO STUB DEVE ANCHE RIPORTARE LA RETE A CASA. `isTauri` non accende
 * solo il ramo nativo: accende `installNetShim` (`lib/shell/net.ts`), che
 * riscrive OGNI `fetch` relativo verso `http://127.0.0.1:13333` — il proxy di
 * loopback che il guscio vero fa girare in Rust. Sotto Playwright lì non c'è
 * nessuno: la prima versione di questo test fingeva Tauri e basta, e la pagina
 * restava senza server (`Failed to fetch` a schermo, nessuna pane seminata,
 * nessun `browser_open`). Contava uno stub che non aveva mai sparato un colpo.
 * Rimappare quell'origine sull'origine della pagina è il pezzo mancante dello
 * stesso travestimento, non uno sconto: il guscio vero ha davvero un server a
 * quell'indirizzo.
 *
 * PERCHÉ SI FALSIFICA `document.visibilityState` invece di nascondere davvero la
 * finestra: sotto Playwright una pagina in primo piano resta `visible`, e la
 * guardia legge esattamente quella property — sovrascriverla è l'iniezione più
 * vicina al segnale vero. Il passo «visibile» prima del passo «nascosta» esiste
 * apposta: senza, lo zero finale sarebbe uno zero a vuoto (la pane poteva non
 * essersi mai aperta).
 */
const HIDDEN_WINDOW_MS = 3000;
/** Il periodo del drain PIÙ LENTO dei due (`browser_take_nav_errors`, 1s).
 *  Il recupero si misura contro questo: una lettura che arriva molto prima di
 *  un periodo non può essere un tick, può solo essere il catch-up. */
const SLOW_DRAIN_MS = 1000;
/** Finestra concessa al recupero. Molto sotto SLOW_DRAIN_MS, molto sopra il
 *  costo di una IPC finta (che è una microtask). */
const CATCH_UP_MS = 250;

interface InvokeProbeWindow {
  __invokeProbe: Record<string, number>;
  __topicsHidden: boolean;
}

/**
 * Veste la pagina da guscio Tauri: ponte IPC contatore, visibilità pilotabile,
 * e la rete del guscio (proxy di loopback) riportata sull'origine della pagina.
 */
async function installTauriInvokeProbe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as InvokeProbeWindow & { __TAURI_INTERNALS__: unknown };
    w.__invokeProbe = {};
    w.__topicsHidden = false;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (w.__topicsHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => w.__topicsHidden,
    });

    // ── La rete del guscio, riportata a casa ────────────────────────────────
    // Gli stessi due indirizzi che `lib/shell/net.ts` usa quando `isTauri`.
    const HTTP_PROXY = "http://127.0.0.1:13333";
    const WS_PROXY = "ws://127.0.0.1:13333";
    const wsOrigin = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
    const toLocal = (u: string): string => {
      if (u.startsWith(HTTP_PROXY)) return location.origin + u.slice(HTTP_PROXY.length);
      if (u.startsWith(WS_PROXY)) return wsOrigin + u.slice(WS_PROXY.length);
      return u;
    };

    // `installNetShim` avvolge il `fetch` che trova al boot, cioè QUESTO: gli
    // arriva quindi l'URL già riscritto verso il proxy, e lo si rimanda
    // all'origine della pagina prima della fetch vera.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === "string") return nativeFetch(toLocal(input), init);
      if (input instanceof URL) return nativeFetch(toLocal(input.href), init);
      if (input instanceof Request) return nativeFetch(new Request(toLocal(input.url), input), init);
      return nativeFetch(input, init);
    }) as typeof fetch;

    // I WebSocket non passano dallo shim: i callsite costruiscono l'URL con
    // `serverWsBase()`, quindi si intercetta il costruttore. Un Proxy e non una
    // sottoclasse, così le costanti statiche (OPEN, CLOSED…) restano quelle.
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args: [string | URL, (string | string[])?]) {
        return new target(toLocal(String(args[0])), args[1]);
      },
    });

    const EMPTY: unknown[] = [];
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: (cmd: string) => {
        w.__invokeProbe[cmd] = (w.__invokeProbe[cmd] ?? 0) + 1;
        // Risposte innocue: nessun comando deve RIGETTARE, o la pane resta su
        // "Initializing native browser…" e il test misurerebbe una pane morta.
        if (cmd === "browser_eval_js") return Promise.resolve("");
        if (cmd.startsWith("browser_take_") || cmd === "browser_nav_entries") return Promise.resolve(EMPTY);
        return Promise.resolve(null);
      },
    };
  });
}

test.describe("perf: guscio nativo a riposo", () => {
  test("finestra nascosta: i due drain IPC della pane browser tacciono, e al ritorno recuperano", async ({ page, request }) => {
    const paneId = "browser:idle-drain-probe";
    await seedPaneStore(request, () => ({
      panes: {
        [paneId]: { id: paneId, type: "browser", title: "idle-drain-probe", url: "about:blank" },
      },
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: [paneId],
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));

    await installTauriInvokeProbe(page);
    await goToApp(page);

    const count = (cmd: string) =>
      page.evaluate(
        (c) => (window as unknown as InvokeProbeWindow).__invokeProbe[c] ?? 0,
        cmd,
      );
    const drains = async () =>
      (await count("browser_take_nav_state")) + (await count("browser_take_nav_errors"));
    const resetProbe = () =>
      page.evaluate(() => { (window as unknown as InvokeProbeWindow).__invokeProbe = {}; });
    const setHidden = (hidden: boolean) =>
      page.evaluate((h) => {
        (window as unknown as InvokeProbeWindow).__topicsHidden = h;
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);

    // La pane si apre davvero (il ponte ha ricevuto `browser_open`).
    await expect.poll(() => count("browser_open"), { timeout: 20000 }).toBeGreaterThan(0);

    // Passo 1, visibile: i drain battono. È il controllo che la sonda è cablata.
    await resetProbe();
    await expect.poll(drains, { timeout: 5000 }).toBeGreaterThan(0);

    // Passo 2, nascosta: zero, per tre secondi pieni — dodici tick del drain
    // veloce e tre di quello lento, se non fossero gated.
    await setHidden(true);
    await resetProbe();
    await page.waitForTimeout(HIDDEN_WINDOW_MS);
    expect(await drains(), "drain nativi con la finestra NASCOSTA").toBe(0);

    // Passo 3, di nuovo visibile: il recupero è IMMEDIATO. Si misura sul drain
    // lento, l'unico la cui lettura entro CATCH_UP_MS non possa essere spiegata
    // da un tick periodico.
    await resetProbe();
    await setHidden(false);
    await page.waitForTimeout(CATCH_UP_MS);
    expect(
      await count("browser_take_nav_errors"),
      `recupero entro ${CATCH_UP_MS}ms dal ritorno (il periodo è ${SLOW_DRAIN_MS}ms)`,
    ).toBeGreaterThan(0);
  });
});
