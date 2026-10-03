import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { canonicalTmpRoot } from "./helpers/file-project";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * SRC — la mappa della ricerca.
 *
 * 2026-08-06: ⌘⇧P finds a project · ⌘P opens a file by name · ⌘F searches
 * the projects' contents · ⌘⇧F withdrawn, an identical alias of ⌘P, with the
 * letter F leading to two different things told apart only by Shift.
 *
 * 2026-10-03 (change find-in-pane), THE REVERSAL: ⌘F finds INSIDE the
 * focused pane (the chat's, terminal's, file's, browser's bar), as in every
 * application; the search in the projects' contents moves to ⇧⌘F and stays
 * on ⌘F only in panes with nothing to search. ⌘F and ⇧⌘F share the letter
 * again, but now for THE SAME search at two widths, here or across the
 * projects, as in VS Code: not the ambiguity of 08/06. So SRC-02 and SRC-04
 * move to ⇧⌘F, SRC-03 flips (⌘F in a text field opens the pane's bar, not
 * the project search) and SRC-05 flips (⇧⌘F opens the contents search).
 *
 * E il difetto che rendeva tutto inservibile: `focusedProjectPath` riconosceva
 * solo la tab del progetto o una chat che vi appartiene. Dentro un progetto il
 * fuoco finisce quasi subito su una pane interna (terminale, git, file), che
 * non è né l'una né l'altra — quindi il progetto spariva e ⌘F non rispondeva.
 *
 * @covers CMD-01
 * @covers FIND-02
 */

const PROJECT_DIR = `${canonicalTmpRoot()}/e2e-search-shortcuts`;
const PROJECT_PANE = `project:${encodeURIComponent(PROJECT_DIR)}`;
/** The second project: it exists only for the PARTIAL results case. */
const PROJECT_DIR_B = `${canonicalTmpRoot()}/e2e-search-shortcuts-b`;
const PROJECT_PANE_B = `project:${encodeURIComponent(PROJECT_DIR_B)}`;

test.describe.serial("Ricerca — mappa dei tasti", () => {
  let topicId: string | null = null;
  let topicIdB: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(`${PROJECT_DIR}/marcatore-univoco.txt`, "parolachiavecercabile\n");
    // Un topic legato al progetto: è una delle sorgenti che rendono la sua
    // cartella nota al server (allowlist di `known-project-dirs`).
    const topic = await createTopic(request, "E2E-SearchShortcuts", { projectPath: PROJECT_DIR });
    topicId = topic.id;

    mkdirSync(PROJECT_DIR_B, { recursive: true });
    writeFileSync(`${PROJECT_DIR_B}/marcatore-univoco.txt`, "parolachiavecercabile\n");
    const topicB = await createTopic(request, "E2E-SearchShortcutsB", { projectPath: PROJECT_DIR_B });
    topicIdB = topicB.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
    if (topicIdB) await deleteTopic(request, topicIdB);
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

  test("SRC-02: ⌘P apre per NOME, ⇧⌘F commuta su CONTENUTO senza chiudere", async ({ page, request }) => {
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
    await page.keyboard.press("Meta+Shift+f");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("file-search-mode-content")).toHaveAttribute("aria-pressed", "true");

    // Lo stesso tasto due volte chiude.
    await page.keyboard.press("Meta+Shift+f");
    await expect(page.getByTestId("file-search")).toHaveCount(0);
  });

  test("SRC-03: ⌘F in un campo di testo apre la barra della pane, non la ricerca nei progetti", async ({ page, request }) => {
    // Flipped on 2026-10-03: the handler used to step aside for every text
    // field and leave ⌘F to it; on a Mac the field did nothing with it (the
    // app's webview has no find of its own), on Windows WebView2's find bar
    // opened over the interface. Now ⌘F from the chat composer opens the
    // chat's bar. The Mac's real Ctrl stays with the field: find-in-pane.spec.ts
    // proves it.
    // A chat of its own, outside any project: a project-linked chat lives
    // inside its project window, not as a top-level tab.
    const chat = await createTopic(request, `E2E-SearchShortcuts-chat-${Date.now()}`);
    try {
      await resetPaneStore(request, [chat.id]);
      await goToApp(page);
      await page.keyboard.press("Escape");

      const composer = page.getByTestId("chat-message-input").filter({ visible: true }).first();
      await expect(composer).toBeVisible({ timeout: 15_000 });
      await composer.click();
      await expect(composer).toBeFocused({ timeout: 5_000 });
      await page.keyboard.press("Meta+f");
      await expect(page.getByTestId("find-bar").filter({ visible: true }).first()).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId("file-search")).toHaveCount(0);
    } finally {
      await deleteTopic(request, chat.id);
    }
  });

  test("SRC-04: con una pane INTERNA a fuoco il progetto resta noto — ⇧⌘F si apre", async ({ page, request }) => {
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

    await page.keyboard.press("Meta+Shift+f");
    const panel = page.getByTestId("file-search");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // E il perimetro nomina il progetto, non «files» generico.
    await expect(panel.locator("input")).toHaveAttribute("placeholder", /e2e-search-shortcuts|progetti/i);
    await page.keyboard.press("Escape");
  });

  test("SRC-05: ⇧⌘F apre la ricerca nel CONTENUTO dei progetti", async ({ page, request }) => {
    // Flipped on 2026-10-03 (see the header): ⇧⌘F is the search across the
    // open projects, ⌘F the one inside the focused pane.
    await resetPaneStore(request, [PROJECT_PANE]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+Shift+f");
    const panel = page.getByTestId("file-search");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId("file-search-mode-content")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("SRC-06: un progetto che non risponde viene NOMINATO sopra i risultati parziali", async ({ page, request }) => {
    // Two projects open, one answers and one does not. `Promise.allSettled`
    // kept the results of whoever answered and threw away the fact that the
    // other one was gone: partial results with the air of being all of them,
    // since a group header only names the projects that ARE there.
    await resetPaneStore(request, [PROJECT_PANE, PROJECT_PANE_B]);
    await goToApp(page);
    await page.keyboard.press("Escape");

    await page.route("**/api/files/search?*", async (route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ?? "";
      if (path === PROJECT_DIR_B) {
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
        return;
      }
      await route.continue();
    });

    const projectTab = page.locator(`[data-pane-id="${PROJECT_PANE}"]`).first();
    await expect(projectTab).toBeVisible({ timeout: 15_000 });
    await projectTab.click({ force: true });
    await expect(projectTab).toHaveAttribute("data-active", "true", { timeout: 10_000 });

    await page.keyboard.press("Meta+Shift+f");
    const panel = page.getByTestId("file-search");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.locator("input").fill("parolachiavecercabile");

    // The silent project is named, above the other one's results.
    await expect(panel.getByTestId("file-search-partial")).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText(/e2e-search-shortcuts-b/);

    await page.unroute("**/api/files/search?*");
    await page.keyboard.press("Escape");
  });
});
