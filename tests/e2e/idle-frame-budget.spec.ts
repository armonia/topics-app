import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";

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
 * Il budget è volutamente largo: a ~60Hz una pompa continua fa ~180 rAF in 3s,
 * mentre un'app davvero a riposo ne fa una manciata (transizioni che finiscono,
 * un observer che si assesta). Fallire qui vuol dire "qualcosa gira a frame
 * pieno mentre non succede niente", non "un frame di troppo".
 */

/** Finestra di misura, ms. */
const WINDOW_MS = 3000;
/**
 * Soglia. A ~60Hz continui in WINDOW_MS si fanno ~180 rAF.
 *
 * La baseline NON è zero ed è voluta: `lib/fpsMonitor.ts` misura 1s ogni 5 per
 * poter mostrare gli FPS in status bar, cioè ~20% di duty cycle a frame pieno
 * (~60-90 rAF in questa finestra). È l'unico consumatore legittimo a riposo.
 * La soglia sta in mezzo fra quella baseline e una pompa continua: sopra 130
 * qualcuno chiede un frame OGNI frame mentre non succede niente.
 */
const MAX_RAF = 130;
/** Un observer che si assesta ne emette pochi; a frame pieno sono centinaia. */
const MAX_RESIZE_NOTIFICATIONS = 60;

interface FrameProbe {
  raf: number;
  resize: number;
  rafTop: [string, number][];
}

test.describe("perf: app a riposo", () => {
  test("niente pompa di rAF/ResizeObserver quando non succede niente", async ({ page }) => {
    // Le sonde vanno installate PRIMA del bundle: gli observer creati al boot
    // devono passare dal nostro wrapper, altrimenti li conteremmo a zero.
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
          // dire QUALE modulo pompa, senza dover indovinare dal profilo nativo.
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

    await goToApp(page);
    // Boot, animazioni d'ingresso e primo assestamento del layout non contano.
    await page.waitForTimeout(2500);

    const probe = await page.evaluate(async (windowMs: number): Promise<FrameProbe> => {
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

    // Sempre stampato: quando fallisce, la prima riga di rafTop È la diagnosi.
    console.log(
      `[idle-frame-budget] rAF=${probe.raf} resize=${probe.resize} in ${WINDOW_MS}ms\n` +
        probe.rafTop.map(([src, n]) => `  ${n}× ${src}`).join("\n"),
    );

    expect(probe.raf, `rAF a riposo (top: ${probe.rafTop[0]?.[0] ?? "—"})`).toBeLessThan(MAX_RAF);
    expect(probe.resize, "notifiche ResizeObserver a riposo").toBeLessThan(MAX_RESIZE_NOTIFICATIONS);
  });
});
