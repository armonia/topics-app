/**
 * SUL TELEFONO UNA TAB È UNA TAB, comunque si presenti — misurato, non creduto.
 *
 * Nella colonna della PWA la stessa cosa compare in tre forme: la tessera
 * fissata, la riga della lista, la tab della barra delle pane. Devono leggersi
 * come la stessa superficie, e non lo facevano (Attilio, 09/08: «le spaziature
 * non mi sembrano coerenti fra ogni tab e tipo tab, e i colori non sono coerenti
 * fra le tab»). Misurato a 390×844 prima di toccare niente:
 *
 *   · fondo a riposo   tessera `oklab(0 0 0 / 0.08)` · riga `0.05`
 *   · corpo del nome   tessera 13px · riga 14px
 *   · incasso          tessera 6px · riga 8px
 *
 * Tre valori diversi per tre facce della stessa cosa, e ognuno nato da un posto
 * che si era corretto per conto suo. Questo file è il posto dove tornano a
 * separarsi in ROSSO invece che sullo schermo.
 *
 * NON confronta un valore atteso scritto a mano: confronta le superfici FRA
 * LORO. Un test che dicesse «il fondo è 0.08» resterebbe verde con la riga a
 * 0.05, che è esattamente il difetto; e diventerebbe rosso per una scelta
 * legittima di ritaratura. Qui il contratto è la COERENZA, e quella non ha
 * ragione di cambiare.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

interface Profilo {
  paddingLeft: string;
  paddingRight: string;
  borderRadius: string;
  fondo: string;
  corpo: string;
  peso: string;
}

const creati: string[] = [];

test.afterAll(async ({ request }) => {
  for (const id of creati) await deleteTopic(request, id).catch(() => {});
  creati.length = 0;
});

async function apriColonna(page: Page): Promise<void> {
  // Sul telefono la colonna è un cassetto che RICORDA dov'eri: senza questo
  // parte chiusa (`width: 0` in App.tsx) e ogni misura esce zero — cioè il test
  // passerebbe confrontando due nulla.
  await page.addInitScript(() => {
    try { localStorage.setItem("topics-mobile-drawer-collapsed", "0"); } catch { /* private mode */ }
  });
}

test.describe("Le tre facce di una tab, sullo schermo dove collassano in una", () => {
  test("TAB-COERENZA-1: tessera fissata e riga della lista sono la STESSA superficie", async ({ page, request }) => {
    const stamp = Date.now();
    const fissata = await createTopic(request, `E2E-Coer-Fissata-${stamp}`);
    creati.push(fissata.id);
    for (let i = 0; i < 2; i++) {
      const t = await createTopic(request, `E2E-Coer-Riga-${i}-${stamp}`);
      creati.push(t.id);
    }
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline", showArchived: false, expandedNodes: [],
        pinnedItems: [fissata.id], pinnedLayout: [[fissata.id]],
      },
    }).catch(() => {});

    await page.setViewportSize({ width: 390, height: 844 });
    await apriColonna(page);
    await goToApp(page);

    const colonna = page.getByTestId("sidebar-topic-list");
    await expect(colonna).toBeVisible({ timeout: 15000 });
    // Precondizione esplicita: se il cassetto è chiuso non c'è niente da
    // confrontare, e il test deve dirlo invece di passare a vuoto.
    await expect
      .poll(async () => (await colonna.boundingBox())?.width ?? 0, { timeout: 15000 })
      .toBeGreaterThan(200);

    await expect(page.getByTestId("pinned-tile").first()).toBeVisible({ timeout: 15000 });

    const misure = await page.evaluate(() => {
      const fondo = (el: Element): string => {
        let e: Element | null = el;
        while (e) {
          const c = getComputedStyle(e).backgroundColor;
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
          e = e.parentElement;
        }
        return "—";
      };
      const profilo = (el: Element) => {
        const cs = getComputedStyle(el);
        // Il corpo del NOME, non della scatola: la riga mette la misura sul
        // contenitore e i figli la ereditano, la tessera la mette sul nome.
        let nome: Element | null = null;
        for (const s of Array.from(el.querySelectorAll("span,div"))) {
          const t = (s.textContent ?? "").trim();
          if (t.length >= 3 && !/^\d+$/.test(t) && s.children.length === 0) { nome = s; break; }
        }
        const ns = nome ? getComputedStyle(nome) : cs;
        return {
          paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight,
          borderRadius: cs.borderRadius, fondo: fondo(el),
          corpo: ns.fontSize, peso: ns.fontWeight,
        };
      };
      const root = document.querySelector('[data-testid="sidebar-topic-list"]');
      if (!root) return null;
      const tessera = root.querySelector('[data-testid="pinned-tile"]');
      const righe = Array.from(root.querySelectorAll('[role="treeitem"]'))
        .filter((e) => !e.closest('[data-testid^="pinned-tile"]'))
        .filter((e) => e.getBoundingClientRect().width > 100);
      if (!tessera || !righe.length) return null;
      return { tessera: profilo(tessera), riga: profilo(righe[0]) };
    });

    expect(misure, "tessera o righe non montate").not.toBeNull();
    const { tessera, riga } = misure as { tessera: Profilo; riga: Profilo };

    // Il fondo a riposo. Era 0.08 contro 0.05: due tinte per la stessa quiete,
    // e la seconda era il valore che il repo aveva GIÀ misurato come troppo
    // debole su questo schermo (1,10:1 contro 1,18:1).
    expect(tessera.fondo, "il fondo a riposo deve essere lo stesso").toBe(riga.fondo);
    // L'incasso orizzontale: ROW_PX, «l'incasso canonico di una riga di
    // contenuto», su entrambe.
    expect(tessera.paddingLeft).toBe(riga.paddingLeft);
    expect(tessera.paddingRight).toBe(riga.paddingRight);
    // Il corpo del nome. Il PESO no: sopra un fill di attenzione una riga passa
    // a semibold di proposito (ON_FILL_TEXT), e legarlo qui renderebbe rosso un
    // comportamento voluto.
    expect(tessera.corpo, "il corpo del nome deve essere lo stesso").toBe(riga.corpo);
    // La forma della card.
    expect(tessera.borderRadius).toBe(riga.borderRadius);
  });
});
