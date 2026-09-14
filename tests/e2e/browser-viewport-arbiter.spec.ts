import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// Chi sporca pulisce: vedi la docstring di `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

/**
 * In condivisione il viewport lo decide chi USA la pagina, e chi guarda la vede
 * in scala al centro.
 *
 * Un contesto browser lato server puo' avere piu' spettatori: la pane del Mac,
 * un telefono sulla stessa rete, il cassetto di un task. Ognuno trasmette la
 * propria misura da un ResizeObserver, e il server applicava l'ultimo `resize`
 * arrivato — cosi' un telefono che si limitava ad APRIRE il contesto condiviso
 * rifluiva la pagina a 390 px sotto le mani di chi stava scrivendo sul Mac.
 * Niente errori: la pagina diventava semplicemente una pagina da telefono.
 *
 * Qui si provano le due meta' della regola, ciascuna col mezzo che le serve:
 *
 *   1. l'arbitrato, sul server VERO — due contesti Playwright con misure
 *      diverse sullo stesso contextId, e la misura che la pagina headless ha
 *      davvero letta da `/api/browsers/:id/agent/eval`. Niente mock: l'arbitro
 *      sta nel ramo socket del server, e uno stub proverebbe lo stub.
 *   2. la centratura, sul mock harness — deterministica, senza browser vero,
 *      perche' la geometria e' una funzione della coppia contenitore/pagina e
 *      non ha bisogno di un Chromium per essere sbagliata.
 *
 * @covers TOPIC-BROWSER-05
 */

/** Il flusso rrweb registrato offline, riusato qui con un Meta piu' largo. */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as { type: number; data?: Record<string, unknown> }[];

/** Il Meta del campione dichiara 900x600: qui serve una pagina da scrivania. */
const RECORDED_WIDTH = 1280;
const RECORDED_HEIGHT = 800;

function eventsWithRecordedViewport(width: number, height: number): unknown[] {
  return RRWEB_EVENTS.map((event) =>
    event.type === 4
      ? { ...event, data: { ...(event.data ?? {}), width, height } }
      : event,
  );
}

test.describe("Arbitro del viewport in sessione condivisa", () => {
  /**
   * QUESTO FILE NON GIRA NEL GATE DELLE PR, per la ragione della sua famiglia.
   *
   * Il primo test fa lanciare al server un Chromium headless (il `resize` e' la
   * prima cosa che crea il contesto). Sotto i quattro shard del gate quel launch
   * va in timeout a 180s — misurato sulla stessa famiglia, vedi il commento di
   * `browser-shared-session` — e il rosso accusa l'arbitro, che non c'entra:
   * non c'era nessuna pagina di cui misurare il viewport. Sta quindi in
   * `NIGHTLY_ONLY_SPECS`, dove gira senza sharding.
   */
  test("l'arbitro del viewport: chi guarda non rimpicciolisce chi usa", async ({ browser, request }) => {
    // Il tetto del file e' 30s e qui non basta: si aspetta che il server lanci
    // un Chromium headless, e poi tre viaggi di andata e ritorno sulla pagina.
    test.setTimeout(180_000);

    const contextId = `e2e-arbiter-${Date.now()}`;
    const evalUrl = `${E2E_BASE}/api/browsers/${encodeURIComponent(contextId)}/agent/eval`;

    /** La misura che la pagina headless ha DAVVERO, non quella che le e' stata chiesta. */
    const readViewport = async (): Promise<string> => {
      const res = await request.post(evalUrl, {
        data: { expression: "[window.innerWidth, window.innerHeight].join('x')" },
        timeout: 60_000,
      });
      if (!res.ok()) return `http ${res.status()}`;
      const body = (await res.json()) as { result?: unknown; error?: string };
      if (body.error) return body.error;
      return typeof body.result === "string" ? body.result : JSON.stringify(body.result);
    };

    // Due dispositivi veri, con due misure diverse: la scrivania e il telefono.
    const desktop = await browser.newContext({ baseURL: E2E_BASE, viewport: { width: 1280, height: 800 } });
    const phone = await browser.newContext({ baseURL: E2E_BASE, viewport: { width: 390, height: 700 } });
    try {
      const desktopPage = await desktop.newPage();
      const phonePage = await phone.newPage();
      await goToApp(desktopPage);
      await goToApp(phonePage);

      /**
       * Apre una socket spettatrice sul contesto condiviso DA DENTRO la pagina,
       * cosi' l'origine e' quella del server e il client e' uno dei suoi.
       *
       * Tiene anche il conto dei `focus_field` ricevuti: e' la ricevuta di
       * lettura di questa socket. I messaggi di una WebSocket sono ordinati,
       * quindi un `focus_query` mandato DOPO un `resize` torna indietro solo
       * quando quel `resize` e' gia' stato trattato — che e' il modo di
       * aspettare un NON-cambiamento senza inventare un'attesa a tempo.
       */
      const attach = (page: import("@playwright/test").Page) =>
        page.evaluate(async (ctx) => {
          const wsBase = location.origin.replace(/^http/, "ws");
          const socket = new WebSocket(`${wsBase}/ws/browser/${encodeURIComponent(ctx)}`);
          const shared = window as unknown as { __arbiter?: { socket: WebSocket; acks: number } };
          const state = { socket, acks: 0 };
          socket.addEventListener("message", (ev) => {
            try {
              if (JSON.parse((ev as MessageEvent).data as string)?.type === "focus_field") state.acks += 1;
            } catch { /* non-JSON frame: not our receipt */ }
          });
          shared.__arbiter = state;
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve());
            socket.addEventListener("error", () => reject(new Error("ws error")));
          });
        }, contextId);

      const send = (page: import("@playwright/test").Page, message: unknown) =>
        page.evaluate((msg) => {
          const shared = window as unknown as { __arbiter: { socket: WebSocket } };
          shared.__arbiter.socket.send(JSON.stringify(msg));
        }, message);

      /** Quante ricevute ha visto finora questa pagina. */
      const acks = (page: import("@playwright/test").Page) =>
        page.evaluate(() => (window as unknown as { __arbiter: { acks: number } }).__arbiter.acks);

      /** Manda la domanda-ricevuta e aspetta che la risposta torni. */
      const roundTrip = async (page: import("@playwright/test").Page) => {
        const before = await acks(page);
        await send(page, { type: "focus_query" });
        await expect
          .poll(() => acks(page), { timeout: 60_000, message: "la socket non ha ricevuto la ricevuta del server" })
          .toBeGreaterThan(before);
      };

      // 1) La scrivania arriva per prima e chiede la propria misura. Nessuno ha
      //    ancora toccato la pagina, quindi guida il primo connesso: lei.
      await attach(desktopPage);
      await send(desktopPage, { type: "resize", width: 1280, height: 800 });
      await expect
        .poll(readViewport, { timeout: 120_000, message: "il primo connesso deve poter imporre la sua misura" })
        .toBe("1280x800");

      // 2) Il telefono si connette e trasmette la propria misura SENZA toccare
      //    la pagina. E' uno spettatore: il suo `resize` va lasciato cadere.
      await attach(phonePage);
      await send(phonePage, { type: "resize", width: 390, height: 700 });
      await roundTrip(phonePage);
      expect(await readViewport(), "un telefono che GUARDA non deve rimpicciolire la pagina di chi la usa").toBe("1280x800");

      // 3) Ora il telefono USA la pagina: uno scroll, e la misura che arriva
      //    insieme all'input (`driving`) e' quella di chi guida.
      await send(phonePage, { type: "input", action: "scroll", payload: { x: 10, y: 10, deltaX: 0, deltaY: 120 } });
      await send(phonePage, { type: "resize", width: 390, height: 700, driving: true });
      await expect
        .poll(readViewport, { timeout: 120_000, message: "chi tocca la pagina ne prende il viewport" })
        .toBe("390x700");
    } finally {
      await desktop.close().catch(() => { /* best-effort */ });
      await phone.close().catch(() => { /* best-effort */ });
    }
  });
});

test.describe("La pagina in scala sta al centro", () => {
  test.use({ viewport: { width: 900, height: 780 } });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("la pagina che non riempie il riquadro sta al centro, e segue i cambi di viewport", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    // La pagina condivisa e' stata registrata da una scrivania: il mirror di
    // questo spettatore e' piu' stretto e la deve mostrare in scala.
    browserProcessPageV2.mockDomCoBrowse(eventsWithRecordedViewport(RECORDED_WIDTH, RECORDED_HEIGHT));

    const topic = await createTopic(request, `E2E-FIT-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.evaluate(
        ({ tid, url }) => {
          window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url } }));
        },
        { tid: topic.id, url: "https://example.com" },
      );
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });

      const container = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
      await expect(container).toBeVisible({ timeout: 10_000 });
      await expect(overlay).toBeVisible({ timeout: 10_000 });

      /** I quattro margini fra il riquadro scalato e il contenitore che lo ospita. */
      const margins = async (): Promise<{ left: number; right: number; top: number; bottom: number; width: number; height: number }> => {
        const outer = await container.boundingBox();
        const inner = await overlay.boundingBox();
        if (!outer || !inner) throw new Error("mirror non misurabile: uno dei due riquadri non ha un box");
        return {
          left: inner.x - outer.x,
          right: outer.x + outer.width - (inner.x + inner.width),
          top: inner.y - outer.y,
          bottom: outer.y + outer.height - (inner.y + inner.height),
          width: inner.width,
          height: inner.height,
        };
      };

      // La misura si stabilizza sul primo fullsnapshot; `expect.poll` aspetta
      // quella, non un tick. Senza contenuto il riquadro sarebbe 0x0.
      await expect
        .poll(async () => (await margins()).width > 0, { timeout: 10_000, message: "il mirror non ha ancora preso una misura" })
        .toBe(true);

      const landscape = await margins();
      // Centrato: i margini opposti coincidono. L'asse stretto ne ha due a zero,
      // che e' comunque centrato; quello largo porta lo spazio avanzato, diviso
      // in due. Ed e' proprio quello spazio a dire che la pagina NON e' incollata
      // in alto a sinistra, che era la resa di prima.
      expect(Math.abs(landscape.left - landscape.right), `margini orizzontali diversi: ${JSON.stringify(landscape)}`).toBeLessThanOrEqual(2);
      expect(Math.abs(landscape.top - landscape.bottom), `margini verticali diversi: ${JSON.stringify(landscape)}`).toBeLessThanOrEqual(2);
      expect(
        Math.max(landscape.left, landscape.top),
        `la pagina riempie il riquadro su entrambi gli assi: non c'e' nessuna scala da centrare (${JSON.stringify(landscape)})`,
      ).toBeGreaterThan(2);
      // In scala, non ritagliata: il rapporto della pagina registrata resta.
      expect(landscape.width / landscape.height).toBeCloseTo(RECORDED_WIDTH / RECORDED_HEIGHT, 1);

      // Il driver del contesto cambia (TOPIC-BROWSER-05) e la pagina passa a una
      // misura da telefono: rrweb lo dice con un incrementale ViewportResize, non
      // con un nuovo Meta. Leggere solo il Meta lasciava questo spettatore a
      // scalare per sempre sulla prima misura.
      const portraitWidth = 420;
      const portraitHeight = 900;
      browserProcessPageV2.sendDomEvent({
        type: 3,
        data: { source: 4, width: portraitWidth, height: portraitHeight },
        timestamp: Date.now(),
      });

      await expect
        .poll(async () => {
          const box = await margins();
          return Number((box.width / box.height).toFixed(2));
        }, { timeout: 10_000, message: "il mirror non si e' rifittato sul nuovo viewport" })
        .toBe(Number((portraitWidth / portraitHeight).toFixed(2)));

      const portrait = await margins();
      expect(Math.abs(portrait.left - portrait.right), `margini orizzontali diversi dopo il refit: ${JSON.stringify(portrait)}`).toBeLessThanOrEqual(2);
      expect(Math.abs(portrait.top - portrait.bottom), `margini verticali diversi dopo il refit: ${JSON.stringify(portrait)}`).toBeLessThanOrEqual(2);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
