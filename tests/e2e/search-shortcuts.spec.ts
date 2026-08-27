import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * SRC — la mappa della ricerca, dopo il riordino del 2026-08-06.
 *
 * Prima: ⌘F trovava un PROGETTO (la lettera che in ogni app del mondo vuol dire
 * «cerca qui dentro»), ⌘P si annunciava «Quick-open file» e apriva un grep nel
 * CONTENUTO, ⌘⇧F era un alias identico di ⌘P, e ⌘⇧P non esisteva. La ricerca
 * per nome viveva solo sepolta dentro ⌘K.
 *
 * Dopo: ⌘⇧P trova un progetto · ⌘P apre un file per nome · ⌘F cerca dentro il
 * progetto a fuoco PIÙ quelli aperti · ⌘⇧F ritirato.
 *
 * E il difetto che rendeva tutto inservibile: `focusedProjectPath` riconosceva
 * solo la tab del progetto o una chat che vi appartiene. Dentro un progetto il
 * fuoco finisce quasi subito su una pane interna (terminale, git, file), che
 * non è né l'una né l'altra — quindi il progetto spariva e ⌘F non rispondeva.
 *
 * @covers CMD-01
 */

const PROJECT_DIR = "/tmp/e2e-search-shortcuts";
const PROJECT_PANE = `project:${encodeURIComponent(PROJECT_DIR)}`;

test.describe.serial("Ricerca — mappa dei tasti", () => {
  let topicId: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/marcatore-univoco.txt`, "parolachiavecercabile\n");
    // Un topic legato al progetto: è una delle sorgenti che rendono la sua
    // cartella nota al server (allowlist di `known-project-dirs`).
    const topic = await createTopic(request, "E2E-SearchShortcuts", { projectPath: PROJECT_DIR });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("SRC-01: ⌘⇧P trova un PROGETTO", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+Shift+p");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    // Scope 'projects' e non 'all'. Lo diceva il placeholder del campo, ma
    // quello è una FRASE TRADOTTA: con la app in italiano diventa «Cerca
    // progetti…», e la stessa schermata giusta faceva rosso il cancello. Lo
    // scope adesso sta nel DOM (`data-scope`), e non cambia con la lingua.
    await expect(palette).toHaveAttribute("data-scope", "projects");
    await page.keyboard.press("Escape");
  });

  test("SRC-02: ⌘P apre per NOME, ⌘F commuta su CONTENUTO senza chiudere", async ({ page, request }) => {
    await resetPaneStore(request, [PROJECT_PANE]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+p");
    const panel = page.getByTestId("file-search");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("file-search-mode-name")).toHaveAttribute("aria-pressed", "true");

    // Premere l'ALTRO tasto mentre è aperta cambia modo invece di chiudere:
    // chiudere e riaprire per passare da nome a contenuto era l'attrito che
    // questa superficie unica esiste per togliere.
    await page.keyboard.press("Meta+f");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("file-search-mode-content")).toHaveAttribute("aria-pressed", "true");

    // Lo stesso tasto due volte chiude.
    await page.keyboard.press("Meta+f");
    await expect(page.getByTestId("file-search")).toHaveCount(0);
  });

  test("SRC-03: ⌘F NON ruba la find a un campo di testo", async ({ page, request }) => {
    await resetPaneStore(request, [PROJECT_PANE]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    const input = page.locator("textarea, input[type='text']").first();
    if (await input.count()) {
      await input.click({ force: true }).catch(() => {});
      await expect(input).toBeFocused({ timeout: 5_000 });
      await page.keyboard.press("Meta+f");
      // DELIBERATE FIXED WAIT: the assertion is that the panel does NOT open.
      // `toHaveCount(0)` is true the instant it is asked, so without a window
      // it would pass even on a panel that opens a frame later.
      await page.waitForTimeout(400);
      // Il gestore esce SENZA preventDefault: la superficie a fuoco tiene la sua ⌘F.
      await expect(page.getByTestId("file-search")).toHaveCount(0);
    }
  });

  test("SRC-04: con una pane INTERNA a fuoco il progetto resta noto — ⌘F si apre", async ({ page, request }) => {
    // È il difetto riportato: si apre un progetto dalla tab bar, il fuoco
    // scivola su una pane interna e ⌘F smetteva di rispondere perché
    // `focusedProjectPath` tornava undefined.
    await resetPaneStore(request, [PROJECT_PANE]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    // Clicca la tab del progetto: è il gesto esatto del report.
    //
    // La tab si ASPETTA, non si tenta. `if (await projectTab.count())` era una
    // condizione che non può fallire: quando lo store delle pane non aveva
    // ancora idratato, il conteggio era 0, il click veniva SALTATO in silenzio,
    // e il test proseguiva su una app che non aveva nessun progetto aperto.
    // Da lì gli 800 ms non erano il problema — ⌘F è a scatto singolo: se
    // `searchProjectPaths()` è vuoto `toggleFileSearch` non apre e non
    // ritenta, quindi nessuna attesa avrebbe più fatto comparire il pannello.
    // Il rosso arrivava dopo, sull'expect, e diceva «pannello assente» di un
    // gesto che nessuno aveva fatto.
    const projectTab = page.locator(`[data-pane-id="${PROJECT_PANE}"]`).first();
    await expect(projectTab).toBeVisible({ timeout: 15_000 });
    await projectTab.click({ force: true });
    // La condizione vera al posto del sonno: la tab è SELEZIONATA. È ciò che
    // rende noto il progetto a `focusedProjectPath`, cioè l'unica cosa che il
    // sonno stava sperando fosse successa.
    await expect(projectTab).toHaveAttribute("data-active", "true", { timeout: 10_000 });

    await page.keyboard.press("Meta+f");
    const panel = page.getByTestId("file-search");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // E il perimetro nomina il progetto, non «files» generico.
    await expect(panel.locator("input")).toHaveAttribute("placeholder", /e2e-search-shortcuts|progetti/i);
    await page.keyboard.press("Escape");
  });

  test("SRC-05: ⌘⇧F è ritirato — non apre più niente", async ({ page, request }) => {
    // Era un alias identico di ⌘P, e rubava la lettera F mentre ⌘F faceva
    // tutt'altro: stessa lettera, due bersagli, distinti solo dallo shift.
    await resetPaneStore(request, [PROJECT_PANE]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+Shift+f");
    // DELIBERATE FIXED WAIT: negative assertion again. A withdrawn shortcut
    // opens nothing, and nothing has no event.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("file-search")).toHaveCount(0);
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
  });
});
