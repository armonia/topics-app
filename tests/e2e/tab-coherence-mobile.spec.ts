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

async function openColumn(page: Page): Promise<void> {
  // Sul telefono la colonna è un cassetto che RICORDA dov'eri: senza questo
  // parte chiusa (`width: 0` in App.tsx) e ogni misura esce zero — cioè il test
  // passerebbe confrontando due nulla.
  await page.addInitScript(() => {
    try { localStorage.setItem("topics-mobile-drawer-collapsed", "0"); } catch { /* private mode */ }
  });
}

test.describe("Le tre facce di una tab, sullo schermo dove collassano in una", () => {
  test("TAB-COERENZA-1: tessera fissata e riga della lista sono la STESSA superficie", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-05" });
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
    await openColumn(page);
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

  test("TAB-COERENZA-2: sul telefono la riga SELEZIONATA si stacca da una a riposo", async ({ page, request }) => {
    // Il difetto che questo test esiste per fermare non è estetico: a 390px la
    // riga selezionata, quella che ti aspetta in ambra e quella finita in blu
    // si dipingevano TUTTE come una a riposo. Il fondo del riposo stava nel
    // `base` di `sidebarRowCard`, e le utility `max-md:` — emesse in fondo al
    // foglio — battevano il fill di stato a specificità pari.
    const stamp = Date.now();
    const scelta = await createTopic(request, `E2E-Sel-Scelta-${stamp}`);
    creati.push(scelta.id);
    for (let i = 0; i < 2; i++) {
      const t = await createTopic(request, `E2E-Sel-Riposo-${i}-${stamp}`);
      creati.push(t.id);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await openColumn(page);
    await goToApp(page);

    const colonna = page.getByTestId("sidebar-topic-list");
    await expect(colonna).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () => (await colonna.boundingBox())?.width ?? 0, { timeout: 15000 })
      .toBeGreaterThan(200);

    // Aprire una chat sul telefono CHIUDE il cassetto (usePanelLifecycle): si
    // riapre col comando in testa alla pane, che è l'unico modo che ha anche
    // l'utente.
    await page.getByText(`E2E-Sel-Scelta-${stamp}`).first().click({ timeout: 15000 });
    await page.waitForTimeout(1200);
    const riapri = page.getByRole("button", { name: /Toggle sidebar|Expand sidebar/i }).first();
    await riapri.click({ timeout: 8000 });
    await expect
      .poll(async () => (await colonna.boundingBox())?.width ?? 0, { timeout: 15000 })
      .toBeGreaterThan(200);

    const fondi = await page.evaluate((nome) => {
      const dipinto = (el: Element): string => {
        const c = getComputedStyle(el).backgroundColor;
        return c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" ? c : "—";
      };
      const root = document.querySelector('[data-testid="sidebar-topic-list"]');
      if (!root) return null;
      const righe = Array.from(root.querySelectorAll('[role="treeitem"]'))
        .filter((e) => !e.closest('[data-testid^="pinned-tile"]'))
        .filter((e) => e.getBoundingClientRect().width > 100);
      const scelta = righe.find((e) => (e.textContent ?? "").includes(nome));
      const riposo = righe.find((e) => !(e.textContent ?? "").includes(nome));
      if (!scelta || !riposo) return null;
      return { scelta: dipinto(scelta), riposo: dipinto(riposo) };
    }, `E2E-Sel-Scelta-${stamp}`);

    expect(fondi, "righe non montate dopo la riapertura del cassetto").not.toBeNull();
    const { scelta: fSel, riposo: fRip } = fondi as { scelta: string; riposo: string };
    // Entrambe DIPINGONO — se il riposo fosse trasparente il confronto sarebbe
    // vuoto e passerebbe per il motivo sbagliato.
    expect(fRip, "la riga a riposo deve avere un fondo sul telefono").not.toBe("—");
    expect(fSel, "la riga selezionata deve avere un fondo").not.toBe("—");
    // E sono DIVERSI: è tutto il punto.
    expect(fSel, `selezionata e riposo hanno lo stesso fondo (${fSel})`).not.toBe(fRip);
  });

  test("TAB-COERENZA-3: due righe adiacenti distano quanto due tessere", async ({ page, request }) => {
    // Le card portano `my-[3px]` per lato, cioè mezzo COLUMN_GAP, e due vicine
    // dovrebbero fare 6. Fra fratelli in flusso normale però i margini
    // COLLASSANO al maggiore: misurato 3px, contro i 6 veri delle tessere
    // (`gap: TILE_GAP`). Due ritmi nella stessa colonna, a mezzo passo.
    //
    // Il test unitario che credeva di custodirlo (`selectionStyles.test.ts`)
    // faceva aritmetica su una stringa — `my * 2 === COLUMN_GAP` — quindi non
    // poteva accorgersi del collasso: il numero era giusto, era il rendering a
    // dimezzarlo. Questo lo misura DOVE succede.
    const stamp = Date.now();
    for (let i = 0; i < 3; i++) {
      const t = await createTopic(request, `E2E-Ritmo-Riga-${i}-${stamp}`);
      creati.push(t.id);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await openColumn(page);
    await goToApp(page);

    const colonna = page.getByTestId("sidebar-topic-list");
    await expect(colonna).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () => (await colonna.boundingBox())?.width ?? 0, { timeout: 15000 })
      .toBeGreaterThan(200);

    const passi = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="sidebar-topic-list"]');
      if (!root) return null;
      const candidate = Array.from(root.querySelectorAll('[role="treeitem"]'))
        .filter((e) => !e.closest('[data-testid^="pinned-tile"]'))
        .filter((e) => e.getBoundingClientRect().width > 100);
      // Only DIRECT siblings: two rows at different levels owe each other no
      // step. The group is picked as the LARGEST set sharing a parent, not by
      // trusting the first match's parent — on 26/08 `d4bcd2771` gave the board
      // row a `role="treeitem"` it was missing (axe-core was right: it was the
      // only direct child of a `role="tree"` without one), that row sorted
      // first, it lives under a different parent, and anchoring on it filtered
      // every real topic row away. The measurement then had nothing to measure
      // and the test read as a layout regression, which it was not.
      const perParent = new Map<Element, Element[]>();
      for (const e of candidate) {
        const p = e.parentElement;
        if (!p) continue;
        perParent.set(p, [...(perParent.get(p) ?? []), e]);
      }
      const righe = [...perParent.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const gaps: number[] = [];
      for (let i = 0; i + 1 < righe.length && i < 3; i++) {
        const a = righe[i].getBoundingClientRect();
        const b = righe[i + 1].getBoundingClientRect();
        gaps.push(Math.round(b.top - a.bottom));
      }
      return gaps;
    });

    expect(passi, "righe non montate").not.toBeNull();
    const gaps = passi as number[];
    expect(gaps.length, "servono almeno due righe adiacenti da misurare").toBeGreaterThan(0);
    // COLUMN_GAP = 6, ed è lo stesso passo delle tessere fissate (TILE-14 lo
    // blocca dall'altro lato). Qui il numero è scritto perché è il contratto
    // della colonna, non un rilievo: se cambia, cambia in `selectionStyles`.
    for (const g of gaps) expect(g, `passo fra righe adiacenti: ${gaps.join(",")}`).toBe(6);
  });

  test("TAB-COERENZA-4: il filo dei fissati ha lo stesso spazio sopra e sotto", async ({ page, request }) => {
    // Il filo dichiarava `my-1.5` — 6 per lato, simmetrico nel codice — ma sotto
    // di lui la prima card porta il suo mezzo passo, e a schermo facevano 9
    // contro 6. La simmetria che conta è quella VISTA, non quella scritta:
    // sopra non c'è nessuno che aggiunge (il blocco fissati chiude a 0), sotto
    // sì, quindi i due margini del filo NON possono essere uguali fra loro.
    const stamp = Date.now();
    const fissati: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = await createTopic(request, `E2E-Filo-Pin-${i}-${stamp}`);
      creati.push(t.id); fissati.push(t.id);
    }
    for (let i = 0; i < 2; i++) {
      const t = await createTopic(request, `E2E-Filo-Riga-${i}-${stamp}`);
      creati.push(t.id);
    }
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline", showArchived: false, expandedNodes: [],
        pinnedItems: fissati, pinnedLayout: [fissati],
      },
    }).catch(() => {});

    await page.setViewportSize({ width: 390, height: 844 });
    await openColumn(page);
    await goToApp(page);
    await expect(page.getByTestId("pinned-divider").first()).toBeVisible({ timeout: 15000 });

    const spazi = await page.evaluate(() => {
      const filo = document.querySelector('[data-testid="pinned-divider"]');
      if (!filo) return null;
      const fr = filo.getBoundingClientRect();
      const prev = filo.previousElementSibling;
      const next = filo.nextElementSibling;
      // Sopra: l'ULTIMA tessera del blocco. Sotto: la PRIMA card della lista.
      // Non i contenitori: fra due contenitori lo spazio può essere giusto
      // mentre quello che si vede è sbagliato — è esattamente com'era.
      const tessere = prev?.querySelectorAll('[data-testid="pinned-tile"]');
      const ultima = tessere?.length ? tessere[tessere.length - 1] : null;
      const prima = next?.querySelector('[role="treeitem"]') ?? null;
      if (!ultima || !prima) return null;
      const cs = getComputedStyle(filo);
      return {
        sopra: Math.round(fr.top - ultima.getBoundingClientRect().bottom),
        sotto: Math.round(prima.getBoundingClientRect().top - fr.bottom),
        catena: `filo mt=${cs.marginTop} mb=${cs.marginBottom} | next=${next?.tagName}.${(next?.getAttribute("class") ?? "").split(" ").slice(0,2).join(".")}[${next?.getAttribute("data-testid") ?? ""}] pt=${next ? getComputedStyle(next).paddingTop : "?"} | prima=${prima.tagName} mt=${getComputedStyle(prima).marginTop}`,
      };
    });

    expect(spazi, "filo, tessere o righe non montate").not.toBeNull();
    const { sopra, sotto, catena } = spazi as { sopra: number; sotto: number; catena: string };
    expect(sotto, `il filo respira ${sopra} sopra e ${sotto} sotto — ${catena}`).toBe(sopra);
    // E il valore è il passo della colonna, non un numero qualunque.
    expect(sopra).toBe(6);
  });
});
