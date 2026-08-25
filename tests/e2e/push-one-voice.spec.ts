/**
 * A APP APERTA, UNA VOCE SOLA — e quale, lo dice il dispositivo.
 *
 * La preferenza `whenOpen` ha due valori e devono essere due cose davvero
 * diverse: `native` = parla il sistema operativo, `in-app` = parla la pagina.
 * Mai entrambi. Non c'è asserzione statica che lo dimostri — è un
 * comportamento nel tempo, con due stati che si escludono — quindi la prova è
 * il clip.
 *
 * COSA È FALSIFICATO E COSA NO. La decisione la prende il SERVICE WORKER VERO:
 * la pagina scarica `/sw.js`, lo esegue con un `self` finto e gli consegna un
 * evento `push`. Riscrivere quella decisione qui dentro avrebbe prodotto un
 * test verde anche con un worker che fa il contrario. Sono finte solo le due
 * SUPERFICI che un browser headless non ha: `showNotification` (che disegna un
 * cartello nero, così il video mostra chi ha parlato) e il canale
 * worker→pagina, che diventa un `MessageEvent` su `navigator.serviceWorker` —
 * cioè esattamente l'evento che il worker manderebbe. Il banner in-app che si
 * vede nel video è il componente vero (`InAppBanners`), montato dall'app vera.
 *
 * La terza proprietà, quella che nasce dalla COMPOSIZIONE con i tasti: l'evento
 * consegnato nei due stati è lo STESSO — una domanda con due opzioni — e i tasti
 * si vedono in entrambi. `whenOpen` sceglie chi parla, non se puoi rispondere.
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const VIDEO_DIR = "test-results/videos/push-one-voice";

declare global {
  interface Window {
    /** Consegna una push al service worker vero. Ritorna quante notifiche di
     *  sistema ha mostrato per QUELLA push. */
    __deliverPush?: (payload: Record<string, unknown>) => Promise<number>;
    __systemBanners?: number;
  }
}

/**
 * Installa il banco: scarica il service worker spedito, lo esegue in un global
 * finto e lascia in `window.__deliverPush` la maniglia per consegnargli una push.
 *
 * Il client finto che il worker vede si dichiara `visible` (l'app È aperta e
 * davanti, che è lo scenario di questo test) e il suo `postMessage` diventa un
 * `MessageEvent` su `navigator.serviceWorker`: lo stesso evento che ascolta
 * `subscribeServiceWorkerBanner`.
 */
async function installPushBench(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.__systemBanners = 0;
    const source = await fetch("/sw.js").then((r) => r.text());

    let shownForThisPush = 0;
    const fakeSelf = {
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        if (type === "push") (window as unknown as { __swPush: unknown }).__swPush = fn;
      },
      registration: {
        showNotification: (title: string, options: { body?: string; actions?: { action: string; title: string }[] }) => {
          shownForThisPush++;
          window.__systemBanners = (window.__systemBanners ?? 0) + 1;
          const card = document.createElement("div");
          card.setAttribute("data-testid", "fake-os-banner");
          card.style.cssText = [
            "position:fixed", "top:16px", "right:16px", "z-index:2147483647",
            "width:320px", "padding:12px 14px", "border-radius:12px",
            "background:#111", "color:#fff",
            "font:13px/1.4 -apple-system,system-ui,sans-serif",
            "box-shadow:0 8px 32px rgba(0,0,0,.5)", "border-left:4px solid #60a5fa",
          ].join(";");
          card.innerHTML =
            '<div style="opacity:.55;font-size:10px;letter-spacing:.08em;text-transform:uppercase">Banner di sistema</div>' +
            '<div style="font-weight:600;margin-top:4px"></div><div style="opacity:.8;margin-top:2px"></div>' +
            '<div data-testid="fake-os-banner-actions" style="display:flex;gap:6px;margin-top:8px"></div>';
          (card.children[1] as HTMLElement).textContent = title;
          (card.children[2] as HTMLElement).textContent = options?.body ?? "";
          // I TASTI che il worker ha messo sulla notifica. Il browser headless
          // non disegna notifiche di sistema, quindi li disegna il banco: quello
          // che si misura è `options.actions`, cioè ciò che il worker ha deciso.
          for (const a of options?.actions ?? []) {
            const b = document.createElement("span");
            b.setAttribute("data-action-id", a.action);
            b.textContent = a.title;
            b.style.cssText = "padding:3px 8px;border:1px solid rgba(255,255,255,.35);border-radius:6px;font-size:11px";
            (card.children[3] as HTMLElement).appendChild(b);
          }
          document.body.appendChild(card);
          return Promise.resolve();
        },
      },
      location: { origin: window.location.origin },
      skipWaiting: () => {},
    };

    const fakeClients = {
      matchAll: () => Promise.resolve([{
        visibilityState: "visible",
        postMessage: (m: unknown) => {
          navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: m }));
        },
      }]),
      openWindow: () => Promise.resolve(null),
    };

    const fakeCaches = {
      open: () => Promise.resolve({ put: () => Promise.resolve(), match: () => Promise.resolve(undefined), addAll: () => Promise.resolve() }),
      match: () => Promise.resolve(undefined),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    };

    new Function("self", "clients", "caches", "fetch", source)(
      fakeSelf, fakeClients, fakeCaches, () => Promise.reject(new Error("nessuna rete nel banco")),
    );

    window.__deliverPush = async (payload: Record<string, unknown>) => {
      shownForThisPush = 0;
      const pending: Promise<unknown>[] = [];
      const handler = (window as unknown as { __swPush?: (ev: unknown) => void }).__swPush;
      if (!handler) throw new Error("il service worker non ha registrato l'handler `push`");
      handler({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
      return shownForThisPush;
    };
  });
}

/** La fascia che spiega al video quale preferenza è in vigore.
 *
 *  40px è una misura, non un gusto: la card della board mostra l'anteprima a
 *  268px di larghezza, e il clip è largo 900 — cioè si rimpicciolisce di 3,36×.
 *  A quella scala 40px diventano ~12px, che si leggono ancora; i 30px di prima
 *  ne facevano 9, cioè la riga che deve spiegare il video era la prima a
 *  sparire. Per la stessa ragione le etichette sono corte. */
async function announce(page: Page, text: string): Promise<void> {
  await page.evaluate((label) => {
    let hud = document.getElementById("e2e-push-hud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "e2e-push-hud";
      hud.style.cssText = [
        "position:fixed", "bottom:0", "left:0", "right:0", "z-index:2147483646",
        "padding:14px 18px", "background:rgba(0,0,0,.9)", "text-align:center",
        "color:#fff", "font:700 40px/1.2 -apple-system,system-ui,sans-serif",
        "border-top:5px solid #4ade80", "pointer-events:none",
      ].join(";");
      document.body.appendChild(hud);
    }
    hud.textContent = label;
  }, text);
}

test.describe.serial("push · una voce sola ad app aperta", () => {
  test.describe.configure({ timeout: 90_000 });

  test("«solo native» parla il sistema, «banner in Topics» parla la pagina", async ({ browser }) => {

    test.info().annotations.push({ type: "spec", description: "CHAT-BANNER-01" });
    const ctx = await browser.newContext({
      viewport: { width: 900, height: 480 },
      recordVideo: { dir: VIDEO_DIR, size: { width: 900, height: 480 } },
    });
    const page = await ctx.newPage();

    try {
      await goToApp(page);
      await installPushBench(page);

      const systemBanner = page.getByTestId("fake-os-banner");
      const inAppBanner = page.getByTestId("in-app-banner");

      // Lo STESSO evento nei due stati: una consegna che è una domanda, con le
      // sue due opzioni. Cambia solo `whenOpen` — così il clip mostra che a
      // cambiare è CHI parla, non cosa si può fare.
      const QUESTION = {
        title: "📋 Serve una tua risposta",
        body: "Push a app chiusa — landa su main?",
        url: "/task/uno",
        actions: [{ id: "answer:Landa%20su%20main", title: "Landa su main" }, { id: "approve", title: "Approva" }],
        requests: {
          "answer:Landa%20su%20main": { method: "POST", path: "/api/boards/p/tasks/uno/review", body: { decision: "reject", comment: "Landa su main" } },
          approve: { method: "POST", path: "/api/boards/p/tasks/uno/review", body: { decision: "approve" } },
        },
      };

      // ── Stato 1 · preferenza `native` ────────────────────────────────────
      await announce(page, "Notifica di sistema");
      const shownNative = await page.evaluate((q) => window.__deliverPush!({
        ...q, tag: "task-review-uno", whenOpen: "native",
      }), QUESTION);

      expect(shownNative).toBe(1);
      await expect(systemBanner).toBeVisible();
      // I TASTI ci sono: la notifica di sistema non è tornata un semplice link.
      await expect(systemBanner.getByTestId("fake-os-banner-actions")).toContainText("Landa su main");
      // E la pagina TACE: nessun banner interno per lo stesso evento.
      await expect(inAppBanner).toHaveCount(0);
      await page.waitForTimeout(2200);

      // ── Stato 2 · preferenza `in-app` ────────────────────────────────────
      await page.evaluate(() => document.querySelector('[data-testid="fake-os-banner"]')?.remove());
      await announce(page, "Banner dentro Topics");
      const shownInApp = await page.evaluate((q) => window.__deliverPush!({
        ...q, tag: "task-review-due", whenOpen: "in-app",
      }), QUESTION);

      // Il sistema non ha parlato: la voce è una, ed è la pagina.
      expect(shownInApp).toBe(0);
      await expect(inAppBanner).toBeVisible();
      await expect(inAppBanner).toContainText("Push a app chiusa");
      await expect(systemBanner).toHaveCount(0);
      // E gli STESSI tasti: scegliere dove leggere l'avviso non è rinunciare a
      // rispondere. È la proprietà che la composizione con i tasti aggiunge.
      await expect(inAppBanner.getByTestId("in-app-banner-actions")).toContainText("Landa su main");
      await expect(inAppBanner.getByTestId("in-app-banner-actions")).toContainText("Approva");
      await page.waitForTimeout(2500);

      // ── Il banner in-app non è permanente: passa da solo ─────────────────
      await announce(page, "Passa da solo");
      await expect(inAppBanner).toHaveCount(0, { timeout: 12_000 });
      await page.waitForTimeout(1200);
    } finally {
      await ctx.close();
    }
  });
});
