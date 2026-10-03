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
 * 2026-08-06: ⌘⇧P trova un progetto · ⌘P apre un file per nome · ⌘F cerca nel
 * contenuto dei progetti · ⌘⇧F ritirato, perché era un alias identico di ⌘P e
 * la stessa lettera F portava a due cose diverse, distinte solo dallo shift.
 *
 * 2026-10-03 (change find-in-pane), IL ROVESCIO: ⌘F cerca DENTRO la pane a
 * fuoco (la barra della chat, del terminale, del file, del browser), come in
 * ogni applicazione del mondo; la ricerca nel contenuto dei progetti passa a
 * ⇧⌘F e resta su ⌘F solo nelle pane che non hanno niente da cercare. ⌘F e ⇧⌘F
 * tornano a essere la stessa lettera, ma adesso per LA STESSA ricerca con due
 * ampiezze, qui o in tutti i progetti, come in VS Code: non è più l'ambiguità
 * del 06/08. Quindi SRC-02 e SRC-04 passano a ⇧⌘F, SRC-03 si rovescia (⌘F in un
 * campo di testo apre la barra della pane, non la ricerca nei progetti) e
 * SRC-05 si rovescia (⇧⌘F apre la ricerca nel contenuto).
 *
 * E il difetto che rendeva tutto inservibile: `focusedProjectPath` riconosceva
 * solo la tab del progetto o una chat che vi appartiene. Dentro un progetto il
 * fuoco finisce quasi subito su una pane interna (terminale, git, file), che
 * non è né l'una né l'altra — quindi il progetto spariva e la ricerca non
 * rispondeva.
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
    // Rovesciato il 2026-10-03: prima il gestore usciva su ogni campo di testo
    // e lasciava ⌘F al campo; sul Mac il campo non ne faceva niente (la webview
    // dell'app non ha una ricerca sua), su Windows si apriva la barra di
    // WebView2 sopra l'interfaccia. Ora ⌘F dal campo della chat apre la barra
    // della chat. Il Ctrl proprio del Mac resta al campo: lo prova
    // find-in-pane.spec.ts.
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
    // Rovesciato il 2026-10-03 (vedi l'intestazione): ⇧⌘F è la ricerca in tutti
    // i progetti aperti, ⌘F quella nella pane a fuoco.
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
