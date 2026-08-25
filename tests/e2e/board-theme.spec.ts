/**
 * board-theme.spec.ts — la Board deve essere LEGGIBILE anche in tema chiaro.
 *
 * La Board era l'unico pezzo di app scritto su una palette dark cablata:
 * 277 `text-neutral-*` (fino a `text-neutral-100`, cioè quasi bianco) più le
 * superfici `bg-neutral-800/900/950` e i bordi `border-white/10`, in 10 file
 * sotto `client/src/components/Board/`. Zero occorrenze di `neutral-*` nel
 * resto del client: era una palette parallela, non una scelta di tema.
 *
 * Conseguenza in chiaro: testo quasi bianco su fondo chiaro, e bordi bianchi
 * su superfici bianche — cioè le card sparivano. Non è un dettaglio estetico,
 * è illeggibilità.
 *
 * Questo test NON è uno screenshot: misura il CONTRASTO reale (WCAG 2.1) fra
 * il colore calcolato del testo e lo sfondo calcolato risalendo gli antenati,
 * nei DUE temi. Con la palette vecchia falliva in chiaro con un rapporto
 * intorno a 1 (bianco su bianco). Gli screenshot li allega comunque, come
 * prova durevole per l'umano.
 *
 * Il tema si pilota con `emulateMedia({ colorScheme })`: il default di Topics è
 * `themeMode: 'system'` (`useTheme.ts`), che risolve via `matchMedia` e ha già
 * un listener sul cambio — quindi è il percorso vero, non una forzatura della
 * classe `.dark`.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { contrastOf, effectiveBgOf, contrastRatio, AA_TESTO, AA_GRAFICA } from "./helpers/contrast";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-board-theme-${Date.now()}`;

const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-board-theme/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/* La misura vive in `helpers/contrast.ts`: era scritta qui e RICOPIATA in
 * `empty-state.spec.ts`, e adesso serve anche ai due blocchi in fondo a questo
 * file. Due sorgenti per la stessa aritmetica sono il modo in cui un cancello
 * smette in silenzio di misurare quello che crede — c'è già il precedente della
 * regex su `rgba?\(` che leggeva `oklch()` come nero trasparente e dava 21:1 su
 * una superficie illeggibile. */

test.describe("Board — leggibilità nei due temi", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board-theme" }, null, 2));
    const topic = await createTopic(request, "E2E-Board-Theme", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Card di prova per il contrasto", status: "todo" },
    });
    expect(res.ok()).toBe(true);
    const task = (await res.json()) as { id: string };
    createdTasks.push(`${PROJECT_ID}:${task.id}`);
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  // UN TEST PER TEMA, non un ciclo dentro un test solo. La Board è un pane
  // SINGLETON nel gruppo: appena la apri, `availableTypesForGroup` toglie la
  // voce «Board» dal menu «+», quindi la seconda passata del ciclo trovava un
  // menu senza board e moriva con «no + menu with a Board (kanban) entry
  // found» — un errore che parla del menu mentre il problema è il workspace
  // sporco. Due test separati prendono ognuno il `beforeEach` che azzera
  // pane-store globale e layout di progetto, e falliscono uno per volta
  // dicendo QUALE tema è rotto.
  for (const scheme of ["dark", "light"] as const) {
    test(`BOARD-THEME-01 (${scheme}): la card della board è leggibile`, async ({ page }, testInfo) => {
      test.info().annotations.push({ type: "spec", description: "KANBAN-46" });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await openProjectBoard(page);

      const card = page.locator("[data-task-card]").first();
      await expect(card).toBeVisible({ timeout: 10000 });

      // Il tema è davvero cambiato: la classe `.dark` sull'<html> è la stessa
      // leva che usa il resto dell'app.
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(isDark, `colorScheme=${scheme} deve produrre .dark=${scheme === "dark"}`).toBe(scheme === "dark");

      const { ratio, color, bg } = await contrastOf(page, "[data-task-card]");
      testInfo.annotations.push({
        type: "contrasto",
        description: `${scheme}: ${ratio.toFixed(2)}:1 — testo ${color} su ${bg}`,
      });
      // AA per testo normale. Con la palette vecchia in chiaro era ~1.05:1
      // (quasi-bianco su bianco): non "poco elegante", illeggibile.
      expect(ratio, `contrasto card in tema ${scheme} (testo ${color} su ${bg})`).toBeGreaterThanOrEqual(4.5);

      await testInfo.attach(`board-${scheme}.png`, {
        body: await page.getByTestId("kanban-board").screenshot(),
        contentType: "image/png",
      });
    });
  }
});

/**
 * Superfici rialzate — devono VEDERSI nei due temi.
 *
 * Il difetto sorella della Board: fuori dalla Board l'app usa `bg-white/N` come
 * "rialzo" di superficie (chip/badge/pillola/hover). `bg-white/N` DA SOLO
 * funziona solo su fondo scuro: in tema chiaro è bianco su bianco e il rialzo
 * sparisce — l'elemento smette di leggersi come elemento. La regola di casa,
 * fissata in `client/src/index.css`, è: rialzo tema-agnostico = coppia
 * `bg-black/N dark:bg-white/N` (o i token opachi `bg-elevated`/`bg-app-hover`);
 * `bg-white/N` bare solo su fondo scuro GARANTITO in entrambi i temi.
 *
 * Questo test NON misura il contrasto del testo ma la VISIBILITÀ del rialzo:
 * composita lo sfondo traslucido della superficie fino al primo opaco (stesso
 * metodo del test Board) e lo confronta col fondo del genitore. Un rialzo che
 * si vede ha un delta di canale ≥ soglia; uno invisibile ~0. Il controllo
 * negativo `bg-white/5` bare su superficie chiara prova che il test BECCA il
 * baco (delta ~0 in chiaro), non che lo maschera.
 *
 * Le classi usate nell'harness sono tutte già nel bundle (usate in decine di
 * punti dell'app), quindi il test gira sul CSS compilato vero.
 */
test.describe("Superfici rialzate — visibili nei due temi", () => {
  const VISIBLE_MIN = 3; // delta di canale minimo perché un rialzo si legga
  const INVISIBLE_MAX = 1.5; // sotto questo è "sparito" (bianco su bianco)

  // Ogni voce: un rialzo su un genitore `bg-surface` (opaco: bianco in chiaro,
  // scuro in dark). `expectVisibleIn` dice in quali temi DEVE vedersi.
  const CASES = [
    { name: "guarded-5", cls: "bg-black/5 dark:bg-white/5", expectVisibleIn: ["light", "dark"] },
    { name: "guarded-10", cls: "bg-black/10 dark:bg-white/10", expectVisibleIn: ["light", "dark"] },
    { name: "elevated-token", cls: "bg-elevated", expectVisibleIn: ["light", "dark"] },
    // Anti-pattern: bare `bg-white/5`. In dark si vede (bianco su scuro), in
    // chiaro NO (bianco su bianco). È il baco che la regola vieta.
    { name: "bare-white-5", cls: "bg-white/5", expectVisibleIn: ["dark"], expectInvisibleIn: ["light"] },
  ] as const;

  for (const scheme of ["dark", "light"] as const) {
    test(`SURFACE-ELEV-01 (${scheme}): il rialzo si legge (e il bare bianco no in chiaro)`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");

      // Harness: un genitore opaco `bg-surface`, dentro una riga per caso.
      await page.evaluate((cases) => {
        document.getElementById("elev-harness")?.remove();
        const root = document.createElement("div");
        root.id = "elev-harness";
        root.className = "bg-surface";
        root.style.cssText = "position:fixed;top:0;left:0;z-index:99999;padding:16px;display:flex;gap:12px;";
        for (const c of cases) {
          const cell = document.createElement("div");
          cell.setAttribute("data-elev", c.name);
          cell.className = `${c.cls} rounded-lg`;
          cell.style.cssText = "width:80px;height:48px;display:flex;align-items:center;justify-content:center;";
          cell.textContent = c.name;
          root.appendChild(cell);
        }
        document.body.appendChild(root);
      }, CASES as unknown as { name: string; cls: string }[]);

      // Sfondo composito effettivo (traslucido → primo opaco): `helpers/contrast.ts`.
      const effectiveBg = (sel: string) => effectiveBgOf(page, sel);

      const parentBg = await effectiveBg("#elev-harness");
      const deltaOf = (bg: number[]) =>
        Math.max(Math.abs(bg[0] - parentBg[0]), Math.abs(bg[1] - parentBg[1]), Math.abs(bg[2] - parentBg[2]));

      for (const c of CASES) {
        const bg = await effectiveBg(`[data-elev="${c.name}"]`);
        const delta = deltaOf(bg);
        testInfo.annotations.push({
          type: "rialzo",
          description: `${scheme}/${c.name} (${c.cls}): delta ${delta.toFixed(1)} — superficie rgb(${bg
            .map((n) => Math.round(n))
            .join(",")}) su genitore rgb(${parentBg.map((n) => Math.round(n)).join(",")})`,
        });
        const visibleHere = (c.expectVisibleIn as readonly string[]).includes(scheme);
        const invisibleHere = ((c as { expectInvisibleIn?: readonly string[] }).expectInvisibleIn ?? []).includes(scheme);
        if (visibleHere) {
          expect(
            delta,
            `${c.name} (${c.cls}) in tema ${scheme} deve VEDERSI come rialzo`,
          ).toBeGreaterThanOrEqual(VISIBLE_MIN);
        }
        if (invisibleHere) {
          expect(
            delta,
            `${c.name} (${c.cls}) in tema ${scheme}: bianco su bianco, il rialzo sparisce — è il baco che la regola vieta`,
          ).toBeLessThanOrEqual(INVISIBLE_MAX);
        }
      }

      await testInfo.attach(`surfaces-${scheme}.png`, {
        body: await page.locator("#elev-harness").screenshot(),
        contentType: "image/png",
      });
    });
  }
});

/**
 * L'ALBERO DEI FILE SU UN REPO SPORCO — le tinte di stato git nei due temi.
 *
 * Il cancello del contrasto esisteva già, ma era ancorato a superfici che NON
 * includevano quelle rotte: misurava la card della Board e un banco sintetico di
 * rialzi, mentre il punto che si vedeva a occhio nudo — la colonna dei file di
 * un progetto — non lo guardava nessuno.
 *
 * Cosa c'era: in `FileExplorer` le tinte di stato erano scritte NUDE, senza
 * coppia `dark:`. `text-amber-400` su una superficie chiara misura 1,65:1 e in
 * scuro 9,26:1 — lo STESSO pixel, sei volte meno leggibile in un tema che
 * nell'altro. E lo stesso lavoro, nello stesso pannello, `GitChanges` lo faceva
 * già con le coppie: era una dimenticanza, non una scelta.
 *
 * Qui si misurano i NODI VERI su un repo con stati git veri (M / U dal
 * fixture condiviso), non un banco: il nome del file colorato dallo stato e la
 * lettera accanto. Il banco resta solo per la banda d'errore, che ha bisogno di
 * un guasto di rete per comparire e non si può pretendere da un test.
 */
test.describe("Albero dei file — le tinte di stato git nei due temi", () => {
  test.describe.configure({ timeout: 90_000 });

  let progetto: FileProject | undefined;

  test.beforeAll(async ({ request }) => {
    progetto = await seedFileProject(request, "theme");
  });

  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, progetto);
  });

  test.beforeEach(async ({ request }) => {
    if (!progetto) return;
    await resetPaneStore(request, []);
    await resetProjectPanes(request, progetto.tmpDir);
    await seedProjectPane(request, progetto.tmpDir);
  });

  async function apriAlbero(page: Page, projectPath: string) {
    const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") await projectsSection.click();
    }
    const header = page.locator(`button[title="${projectPath}"]`);
    await expect(header).toBeVisible({ timeout: 10000 });
    await header.click();
    await expect(page.locator('[data-testid="file-tree"]').first()).toBeVisible({ timeout: 15000 });
  }

  for (const scheme of ["dark", "light"] as const) {
    test(`FILETREE-CONTRAST-01 (${scheme}): nomi e lettere di stato git sono leggibili`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await apriAlbero(page, progetto!.tmpDir);

      // Il fixture semina `newfile.txt` non tracciato: la sua riga porta sia il
      // nome colorato sia la lettera. Si aspetta che almeno una compaia — lo
      // stato git arriva dal watcher, non dal primo render dell'albero.
      const lettere = page.locator('[data-testid="git-status-letter"]');
      await expect(lettere.first()).toBeVisible({ timeout: 15000 });

      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(isDark, `colorScheme=${scheme} deve produrre .dark=${scheme === "dark"}`).toBe(scheme === "dark");

      // OGNI nodo colorato, non il primo: gli stati hanno tinte diverse e un
      // controllo sul solo primo passerebbe con gli altri rotti.
      for (const [sel, etichetta] of [
        ['[data-testid="git-status-letter"]', "lettera di stato"],
        ['[data-testid="file-node-name-git"]', "nome del file"],
      ] as const) {
        const quanti = await page.locator(sel).count();
        expect(quanti, `${etichetta}: nessun nodo da misurare, il repo non risulta sporco`).toBeGreaterThan(0);
        for (let i = 0; i < quanti; i++) {
          const { ratio, color, bg } = await contrastOf(page, sel, i);
          testInfo.annotations.push({
            type: "contrasto",
            description: `${scheme} · ${etichetta} #${i}: ${ratio.toFixed(2)}:1 — ${color} su ${bg}`,
          });
          expect(
            ratio,
            `${etichetta} #${i} in tema ${scheme} (${color} su ${bg}): sotto ${AA_TESTO}:1`,
          ).toBeGreaterThanOrEqual(AA_TESTO);
        }
      }

      await testInfo.attach(`file-tree-${scheme}.png`, {
        body: await page.locator('[data-testid="file-tree"]').first().screenshot(),
        contentType: "image/png",
      });
    });
  }
});

/**
 * I SEGNALI DEL CHROME — barra di stato e banda d'errore dell'albero.
 *
 * Il chrome chiaro (#eaecf0) è più SCURO di una superficie di contenuto, quindi
 * una tinta che passa su una card lì può non passare: `text-amber-500` sul
 * chrome misura 1,82:1, `text-emerald-500` 2,09:1. Erano i colori di «2,1GB» in
 * allarme, del pallino del gateway, del badge `dev`.
 *
 * Il banco è montato DENTRO la sidebar vera, non su un `div` con una classe
 * addosso: solo lì valgono sia il fondo del chrome sia le regole che il chrome
 * si ritara per sé (index.css ritara terziario, bordi e — da questo giro — il
 * blu di `text-primary`, che sul chrome chiaro stava a 4,09:1). Un banco
 * appeso al body misurerebbe un'altra superficie e direbbe un altro numero.
 *
 * Le classi qui sotto DEVONO restare allineate alle costanti di
 * `SidebarStatusBar.tsx` e alla banda d'errore di `FileExplorer.tsx`: sono
 * scritte a mano perché una spec non importa dal sorgente del client, ed è lo
 * stesso patto già in piedi in SURFACE-ELEV-01.
 */
test.describe("Chrome — i segnali di stato nei due temi", () => {
  const TESTO = [
    { nome: "ok", cls: "text-emerald-800 dark:text-emerald-400" },
    { nome: "attesa", cls: "text-amber-800 dark:text-amber-400" },
    { nome: "guasto", cls: "text-red-700 dark:text-red-400" },
    { nome: "link-primary", cls: "text-primary" },
  ] as const;
  const GRAFICA = [
    { nome: "pallino-ok", cls: "bg-emerald-600 dark:bg-emerald-400" },
    { nome: "pallino-attesa", cls: "bg-amber-700 dark:bg-amber-400" },
    { nome: "pallino-guasto", cls: "bg-red-500 dark:bg-red-400" },
    { nome: "pallino-spento", cls: "bg-app-text-muted" },
  ] as const;

  for (const scheme of ["dark", "light"] as const) {
    test(`CHROME-SIGNAL-01 (${scheme}): i segnali della barra di stato si leggono`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      const sidebar = page.locator('[role="navigation"][aria-label="Topics sidebar"]');
      await expect(sidebar).toBeVisible({ timeout: 15000 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");

      await page.evaluate(({ testo, grafica }) => {
        document.getElementById("chrome-harness")?.remove();
        const sb = document.querySelector('[role="navigation"][aria-label="Topics sidebar"]');
        if (!sb) throw new Error("sidebar non trovata: il banco deve stare dentro il chrome vero");
        const root = document.createElement("div");
        root.id = "chrome-harness";
        root.style.cssText = "padding:8px;display:flex;gap:8px;align-items:center;";
        for (const c of testo) {
          const s = document.createElement("span");
          s.setAttribute("data-segnale", c.nome);
          s.className = c.cls;
          s.textContent = c.nome;
          root.appendChild(s);
        }
        for (const c of grafica) {
          const s = document.createElement("span");
          s.setAttribute("data-pallino", c.nome);
          s.className = `${c.cls} rounded-full`;
          s.style.cssText = "width:6px;height:6px;display:inline-block;";
          root.appendChild(s);
        }
        sb.appendChild(root);
      }, { testo: TESTO as unknown as { nome: string; cls: string }[], grafica: GRAFICA as unknown as { nome: string; cls: string }[] });

      for (const c of TESTO) {
        const { ratio, color, bg } = await contrastOf(page, `[data-segnale="${c.nome}"]`);
        testInfo.annotations.push({
          type: "contrasto",
          description: `${scheme} · ${c.nome} (${c.cls}): ${ratio.toFixed(2)}:1 — ${color} su ${bg}`,
        });
        expect(
          ratio,
          `${c.nome} (${c.cls}) sul chrome in tema ${scheme}: ${color} su ${bg}, sotto ${AA_TESTO}:1`,
        ).toBeGreaterThanOrEqual(AA_TESTO);
      }

      const fondoChrome = await effectiveBgOf(page, "#chrome-harness");
      for (const c of GRAFICA) {
        const tinta = await effectiveBgOf(page, `[data-pallino="${c.nome}"]`);
        const ratio = contrastRatio(tinta, fondoChrome);
        testInfo.annotations.push({
          type: "contrasto grafica",
          description: `${scheme} · ${c.nome} (${c.cls}): ${ratio.toFixed(2)}:1`,
        });
        // Un pallino è GRAFICA: WCAG chiede 3:1, non 4,5 — una forma si
        // riconosce con meno contrasto di quanto ne serva a leggere una parola.
        expect(
          ratio,
          `${c.nome} (${c.cls}) sul chrome in tema ${scheme}: sotto ${AA_GRAFICA}:1`,
        ).toBeGreaterThanOrEqual(AA_GRAFICA);
      }

      await testInfo.attach(`chrome-signals-${scheme}.png`, {
        body: await page.locator("#chrome-harness").screenshot(),
        contentType: "image/png",
      });
    });

    test(`CHROME-SIGNAL-02 (${scheme}): la banda d'errore dell'albero si legge`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
        .toBe(scheme === "dark");

      // La banda ha un fondo SUO (`amber-500/10`) sopra la superficie del
      // pannello: il testo va misurato sul composito, non sul pannello nudo.
      // Compare solo quando una lettura fallisce, quindi qui si replicano le
      // sue classi su un genitore `bg-elevated` — la superficie su cui vive.
      await page.evaluate(() => {
        document.getElementById("banda-harness")?.remove();
        const root = document.createElement("div");
        root.id = "banda-harness";
        root.className = "bg-elevated";
        root.style.cssText = "position:fixed;top:0;left:0;z-index:99999;padding:8px;";
        const banda = document.createElement("div");
        banda.id = "banda-errore";
        banda.className = "px-3 py-1 text-[11px] text-amber-800 dark:text-amber-400 bg-amber-500/10";
        banda.textContent = "Impossibile aggiornare l'elenco dei file";
        root.appendChild(banda);
        document.body.appendChild(root);
      });

      const { ratio, color, bg } = await contrastOf(page, "#banda-errore");
      testInfo.annotations.push({
        type: "contrasto",
        description: `${scheme} · banda d'errore: ${ratio.toFixed(2)}:1 — ${color} su ${bg}`,
      });
      expect(
        ratio,
        `banda d'errore dell'albero in tema ${scheme} (${color} su ${bg}): sotto ${AA_TESTO}:1`,
      ).toBeGreaterThanOrEqual(AA_TESTO);
    });
  }
});
