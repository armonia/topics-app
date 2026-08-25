/**
 * UN MESSAGGIO, UN BANNER — anche con due finestre aperte.
 *
 * Il banner di `message:new` nasce da un frame che il server manda in
 * BROADCAST: ogni finestra connessa lo riceve, e l'effetto che lo ascoltava era
 * montato una volta PER FINESTRA. Due finestre (i gruppi staccati sono
 * esattamente questo) → due banner per lo stesso messaggio. Nessun gate poteva
 * risolverlo: sono tutti veri contemporaneamente in tutte le finestre.
 *
 * Non c'è asserzione statica che lo dimostri — è un comportamento fra due
 * contesti nel tempo. Quindi la spec apre DUE pagine nello STESSO contesto
 * (stessa origine, quindi lo stesso `localStorage` su cui vive la claim: è la
 * fedele controparte di due finestre della stessa app), le nasconde entrambe,
 * manda UN messaggio e conta.
 *
 * COSA È FALSIFICATO E COSA NO. Il banner del sistema operativo non esiste in un
 * browser headless, quindi lo stub è `window.Notification` — cioè la SUPERFICIE
 * di consegna, non il codice sotto esame: l'app chiama `new Notification(titolo,
 * corpo)` come farebbe sempre, e lo stub disegna esattamente ciò che le è stato
 * chiesto e tiene il conto. Tutto il resto (i gate, la cooldown, la claim
 * cross-finestra, il lock) è il codice vero.
 */
import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Dove Playwright lascia le clip di questa spec. Il .webm che finisce in
 *  consegna nasce da qui (due pagine affiancate, cucite a mano). */
const VIDEO_DIR = "test-results/videos/message-banner-single-delivery";

declare global {
  interface Window {
    __bannerLog?: { title: string; body: string }[];
    __hiddenWindow?: boolean;
  }
}

/**
 * Prepara una pagina come "finestra": le mette un'etichetta visibile, sostituisce
 * `Notification` con uno stub che CONTA e DISEGNA, e le dà l'interruttore per
 * fingersi nascosta.
 *
 * Lo stub va installato prima di `goto`: `useCompletionNotifier` monta il suo
 * primer del permesso al primo render, e una finestra che non risulta
 * `granted` non arriverebbe mai a costruire una `Notification` — il conteggio
 * sarebbe zero ovunque e la spec passerebbe senza aver misurato niente.
 */
async function prepareWindow(page: Page, label: string, tint: string): Promise<void> {
  await page.addInitScript(
    ({ label, tint }: { label: string; tint: string }) => {
      window.__bannerLog = [];
      // Nascosta/visibile su comando: si parte VISIBILE, così l'app fa il suo
      // boot normale (WS, sidebar, pane), e si nasconde al momento giusto —
      // che è anche l'ordine reale dei fatti: prima abbassi la finestra, poi
      // arriva il messaggio.
      window.__hiddenWindow = false;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (window.__hiddenWindow ? "hidden" : "visible"),
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => Boolean(window.__hiddenWindow),
      });

      // Lo stub della SUPERFICIE di consegna. Registra e disegna: il video deve
      // poter mostrare quale finestra ha bannerizzato e quale ha taciuto.
      class FakeNotification {
        static permission = "granted";
        static requestPermission(): Promise<string> { return Promise.resolve("granted"); }
        onclick: (() => void) | null = null;
        constructor(title: string, opts?: { body?: string }) {
          const body = opts?.body ?? "";
          window.__bannerLog!.push({ title, body });
          const card = document.createElement("div");
          card.setAttribute("data-testid", "fake-os-banner");
          card.style.cssText = [
            "position:fixed", "top:16px", "right:16px", "z-index:2147483647",
            "width:320px", "padding:12px 14px", "border-radius:12px",
            "background:#111", "color:#fff", "font:13px/1.4 -apple-system,system-ui,sans-serif",
            "box-shadow:0 8px 32px rgba(0,0,0,.5)", `border-left:4px solid ${tint}`,
          ].join(";");
          card.innerHTML =
            `<div style="opacity:.55;font-size:10px;letter-spacing:.08em;text-transform:uppercase">Banner di sistema</div>` +
            `<div style="font-weight:600;margin-top:4px"></div><div style="opacity:.8;margin-top:2px"></div>`;
          (card.children[1] as HTMLElement).textContent = title;
          (card.children[2] as HTMLElement).textContent = body;
          document.body.appendChild(card);
        }
        close(): void { /* lo stub non si chiude: il video deve poterlo vedere */ }
      }
      (window as unknown as { Notification: unknown }).Notification = FakeNotification;

      // L'etichetta della finestra + il contatore, per il video.
      const paint = (): void => {
        let hud = document.getElementById("e2e-window-hud");
        if (!hud) {
          hud = document.createElement("div");
          hud.id = "e2e-window-hud";
          hud.style.cssText = [
            "position:fixed", "bottom:16px", "left:16px", "z-index:2147483646",
            "padding:10px 14px", "border-radius:10px", "background:rgba(0,0,0,.82)",
            "color:#fff", "font:600 14px/1.3 -apple-system,system-ui,sans-serif",
            `border-left:4px solid ${tint}`, "pointer-events:none",
          ].join(";");
          document.body.appendChild(hud);
        }
        const n = window.__bannerLog!.length;
        hud.innerHTML =
          `<div>${label}</div>` +
          `<div style="font-weight:400;opacity:.75;margin-top:3px">finestra ${window.__hiddenWindow ? "nascosta" : "in primo piano"}` +
          ` · banner: <span style="color:${n ? "#4ade80" : "#f87171"}">${n}</span></div>`;
      };
      const start = (): void => { paint(); setInterval(paint, 200); };
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
    },
    { label, tint },
  );
}

/** Abbassa la finestra: da qui in poi `document.visibilityState === 'hidden'`. */
async function hide(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__hiddenWindow = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Quanti banner ha consegnato questa finestra. */
function bannerCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__bannerLog?.length ?? 0);
}

// Oltre i 30s di default, e non per lentezza: questi due test MISURANO un'attesa
// (il silenzio della finestra che perde la claim, e il silenzio di un topic in
// mute) e un'attesa non si può accorciare senza smettere di misurarla. Più il
// fermo immagine che rende guardabile la clip di consegna.
test.describe.serial("message:new — una consegna per messaggio, non per finestra", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("due finestre nascoste, un messaggio → un banner solo", async ({ browser, request }) => {

    test.info().annotations.push({ type: "spec", description: "CHAT-BANNER-01" });
    const ctx = await browser.newContext({
      recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
    });
    const topicName = `Banner Once ${Date.now()}`;
    const topic = await createTopic(request, topicName);

    try {
      // DUE pagine nello STESSO contesto: stessa origine, quindi lo stesso
      // localStorage e lo stesso LockManager. È ciò che rende questo test una
      // prova e non una simulazione — la claim gira sul canale vero.
      const pageA = await ctx.newPage();
      const pageB = await ctx.newPage();
      await prepareWindow(pageA, "Finestra A", "#60a5fa");
      await prepareWindow(pageB, "Finestra B", "#f59e0b");

      await goToApp(pageA);
      await goToApp(pageB);

      // Le due finestre devono conoscere il topic (il titolo del banner È il suo
      // nome: senza, il gate «topic sconosciuto» le zittisce entrambe e il test
      // conterebbe zero senza aver misurato niente).
      for (const p of [pageA, pageB]) {
        await expect(p.getByRole("treeitem", { name: new RegExp(topicName) })).toBeVisible({
          timeout: 15000,
        });
      }

      // Le finestre identificano se stesse con `topics-window-id` in
      // sessionStorage, che è per-pagina: due claimant diversi, come due finestre
      // vere. Se fossero uguali il test non proverebbe nulla.
      const idA = await pageA.evaluate(() => sessionStorage.getItem("topics-window-id"));
      const idB = await pageB.evaluate(() => sessionStorage.getItem("topics-window-id"));
      expect(idA).toBeTruthy();
      expect(idA).not.toBe(idB);

      // Abbasso entrambe le finestre e lascio che il video lo mostri.
      await hide(pageA);
      await hide(pageB);
      await pageA.waitForTimeout(600);

      // UN messaggio dell'assistente. Il server lo manda in broadcast: lo
      // ricevono tutte e due.
      const marker = `banner-once-${Date.now()}`;
      const res = await request.post(`${E2E_BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: `Ho finito: ${marker}` },
        ignoreHTTPSErrors: true,
      });
      expect(res.ok()).toBeTruthy();

      // Una sola finestra deve consegnare. L'attesa è generosa di proposito: la
      // claim passa da un lock asincrono, e un test che misura "quanti" non deve
      // poter vincere solo perché ha guardato presto.
      await expect
        .poll(async () => (await bannerCount(pageA)) + (await bannerCount(pageB)), {
          timeout: 10000,
          message: "nessuna delle due finestre ha bannerizzato",
        })
        .toBeGreaterThan(0);
      await pageA.waitForTimeout(2500);

      const a = await bannerCount(pageA);
      const b = await bannerCount(pageB);
      expect(a + b).toBe(1);

      // E quella che ha parlato ha detto la cosa giusta.
      const winner = a === 1 ? pageA : pageB;
      const loser = a === 1 ? pageB : pageA;
      const [banner] = await winner.evaluate(() => window.__bannerLog ?? []);
      expect(banner.title).toBe(topicName);
      expect(banner.body).toContain(marker);

      // Lo stesso fatto, ma nel DOM: è ciò che il video INQUADRA. Senza questo,
      // il conteggio vive in una variabile che la clip non può mostrare, e
      // l'anteprima di consegna sarebbe un'illustrazione invece che una prova.
      const card = '[data-testid="fake-os-banner"]';
      await expect(winner.locator(card)).toHaveCount(1);
      await expect(winner.locator(card)).toContainText(topicName);
      await expect(loser.locator(card)).toHaveCount(0);

      // Il video regge il fermo immagine finale.
      await pageA.waitForTimeout(1200);
    } finally {
      await ctx.close();
      await deleteTopic(request, topic.id);
    }
  });

  test("topic silenziato: due finestre nascoste, zero banner", async ({ browser, request }) => {
    // Il gate che il vecchio percorso saltava del tutto — chiamava `notifyNative`
    // fuori dall'unica porta, quindi un topic in mute suonava lo stesso.
    const ctx = await browser.newContext();
    const topicName = `Banner Muted ${Date.now()}`;
    const topic = await createTopic(request, topicName);

    try {
      const muted = await request.patch(`${E2E_BASE}/api/topics/${topic.id}`, {
        data: { muted: true },
        ignoreHTTPSErrors: true,
      });
      expect(muted.ok()).toBeTruthy();

      const pageA = await ctx.newPage();
      const pageB = await ctx.newPage();
      await prepareWindow(pageA, "Finestra A", "#60a5fa");
      await prepareWindow(pageB, "Finestra B", "#f59e0b");
      await goToApp(pageA);
      await goToApp(pageB);
      for (const p of [pageA, pageB]) {
        await expect(p.getByRole("treeitem", { name: new RegExp(topicName) })).toBeVisible({
          timeout: 15000,
        });
      }
      await hide(pageA);
      await hide(pageB);

      const res = await request.post(`${E2E_BASE}/api/topics/${topic.id}/system-message`, {
        data: { content: "questo non deve suonare" },
        ignoreHTTPSErrors: true,
      });
      expect(res.ok()).toBeTruthy();

      // Non c'è un evento da attendere: si aspetta e si constata il silenzio.
      await pageA.waitForTimeout(4000);
      expect(await bannerCount(pageA)).toBe(0);
      expect(await bannerCount(pageB)).toBe(0);
    } finally {
      await ctx.close();
      await deleteTopic(request, topic.id);
    }
  });
});
