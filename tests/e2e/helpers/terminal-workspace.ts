/**
 * Il workspace di prova dei terminali: stato di partenza e apertura di una shell.
 *
 * PERCHÉ ESISTE. `terminal.spec.ts` conteneva tre `describe` indipendenti e —
 * dentro ciascuno — la stessa procedura «apri l'app, espandi Progetti, clicca
 * l'intestazione di /tmp, clicca la topic, hover, "+", "Shell", aspetta xterm»
 * ricopiata per intero: tre volte, già divergenti fra loro (una controllava se
 * una shell era già a schermo, le altre no). Con la copia, un cambio alla UI
 * della sidebar va inseguito in tre punti e chi ne dimentica uno lascia un rosso
 * che sembra un guasto del terminale.
 *
 * È anche ciò che permette di spezzare il file: 76 secondi in uno solo, e
 * Playwright distribuisce gli shard PER FILE — finché quei tre `describe`
 * stavano insieme, nessun numero di shard poteva scendere sotto la loro somma.
 */

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { TerminalPage } from "../fixtures/terminal.fixture";
import {
  createTopic,
  deleteTopic,
  listTerminalSessions,
  deleteTerminalSession,
  deleteAllTerminalSessions,
  resetPaneStore,
  resetProjectPanes,
} from "./api-fixtures";
import { goToApp } from "../helpers";
import { realpathSync } from "node:fs";

/** Il progetto su cui girano i test dei terminali: /tmp esiste sempre (su macOS è un symlink a /private/tmp). */
export const TERMINAL_PROJECT_PATH = "/tmp";

/**
 * THE ROW IS LABELLED WITH THE RESOLVED PATH, and on macOS that is not `/tmp`.
 *
 * The project row carries the path the SERVER registered, and creating a topic
 * on `/tmp` registers it through a realpath: on macOS `/tmp` is a symlink, so
 * the button reads `/private/tmp`. Measured on a fresh e2e database: every
 * terminal spec died on `button[title="/tmp"]` after ten seconds, blaming the
 * sidebar for a name it never had. Matching both spellings costs one selector
 * and removes a whole family of false reds.
 */
const PROJECT_PATH_SPELLINGS = [...new Set([
  TERMINAL_PROJECT_PATH,
  (() => { try { return realpathSync(TERMINAL_PROJECT_PATH); } catch { return TERMINAL_PROJECT_PATH; } })(),
])];

/**
 * CSS for a button carrying `text` as its label, in both places it can live.
 *
 * `TooltipDelegate` moves the value of `title` onto `data-tip` on `mouseover`
 * and puts it back on `mouseout`, and Playwright leaves the pointer where it
 * was: from the second call on, a `title`-only selector looks for an attribute
 * the previous hover already stripped.
 */
function labeledButton(text: string): string {
  return `button[title="${text}"], button[data-tip="${text}"]`;
}

/** The project row, whichever spelling of its path the server registered. */
export function projectRowSelector(): string {
  return PROJECT_PATH_SPELLINGS.map(labeledButton).join(", ");
}

/**
 * Stato di partenza noto per OGNI test (retry-safe: gira a ogni tentativo).
 *
 * Il DB e2e sopravvive fra le run (DATA_DIR=/tmp/topics-test-data) e il canale
 * pane per-progetto è additivo all'hydrate, quindi una pane terminale aperta da
 * una run precedente — o da un RETRY dello stesso test — resta persistita sotto
 * la chiave `topics-project-panes-<hash>` di /tmp e rientra in una pagina nuova.
 * È ciò che faceva pescare a TERM-01 una pane MORTA (vuota → nessun prompt) e
 * contare a TERM-04 3-6 tab invece di 2.
 *
 * Il reset per-progetto non basta: una pane terminale aperta al livello GLOBALE
 * da un altro file (il pane-store è uno solo per l'intera suite seriale)
 * sopravvive, e `navigateAndOpenTerminal` vede `xtermAlreadyVisible` → riusa una
 * shell morta invece di aprirne una.
 *
 * Il pane-store va però azzerato ALLA TOPIC del describe, NON a `[]`. La riga di
 * un progetto nella sidebar è guidata dalle TAB APERTE, non dai topic che
 * esistono: `buildSidebarItems.ts` la salta se non c'è né la tab del progetto né
 * un figlio con una tab aperta. Svuotando il pane-store spariva quindi anche
 * `button[title="/tmp"]`, che è il punto di partenza di ogni test qui.
 */
export async function resetTerminalWorkspace(
  request: APIRequestContext,
  topicId: string,
): Promise<void> {
  await deleteAllTerminalSessions(request);
  await resetPaneStore(request, [topicId]);
  await resetProjectPanes(request, TERMINAL_PROJECT_PATH);
}

/**
 * La topic di un file di spec, legata a /tmp.
 *
 * Il nome porta `label` + timestamp: ogni file deve avere la SUA, o due file che
 * girano su shard diversi (o in sequenza sullo stesso) si contendono le stesse
 * sessioni PTY e le stesse tab.
 */
export async function seedTerminalTopic(
  request: APIRequestContext,
  label: string,
): Promise<{ topicId: string; topicName: string }> {
  const topicName = `e2e-term-${label}-${Date.now()}`;
  const topic = await createTopic(request, topicName, {
    projectPath: TERMINAL_PROJECT_PATH,
  });
  return { topicId: topic.id, topicName };
}

/** Chiude le sessioni PTY della topic e la cancella. Le PTY vivono nel bridge, fuori da SQLite: vanno chiuse a parte. */
export async function cleanupTerminalTopic(
  request: APIRequestContext,
  topicId: string | undefined,
): Promise<void> {
  if (!topicId) return;
  const sessions = await listTerminalSessions(request, topicId).catch(() => []);
  for (const s of sessions) await deleteTerminalSession(request, s.id).catch(() => {});
  await deleteTopic(request, topicId).catch(() => {});
}

/**
 * Apre l'app e porta a schermo la finestra del progetto /tmp con la topic dentro.
 *
 * Si ferma PRIMA di aprire una shell: TERM-03 deve installare l'intercettazione
 * WebSocket prima della navigazione e aprire la shell dopo, quindi i due passi
 * restano separati.
 */
export async function gotoTerminalProject(page: Page, topicName: string): Promise<void> {
  await goToApp(page);

  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    if ((await projectsSection.getAttribute("aria-expanded")) === "false") {
      await projectsSection.click();
    }
  }

  const projectHeader = page.locator(projectRowSelector()).first();
  await projectHeader.waitFor({ state: "visible", timeout: 10000 });
  await projectHeader.click();

  // La topic serve solo a garantire che un gruppo di pane esista: se non c'è, i
  // test aprono comunque la shell nella finestra del progetto.
  const topicItem = page.getByRole("treeitem", { name: topicName });
  await topicItem.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await topicItem.isVisible()) {
    await topicItem.click();
    await page
      .locator('[data-testid="panel-tab-bar"]')
      .last()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
  }
}

/**
 * «+» sulla riga del progetto → «Shell», e attende che xterm sia pronto al prompt.
 *
 * `readyTimeout` è il budget dei DUE tempi d'attesa qui sotto: la pane a
 * schermo e il prompt dentro xterm. Il default resta 15 s, cioè quello che
 * hanno sempre avuto, e nessuna spec cambia comportamento per averlo aggiunto.
 *
 * Esiste perché quel numero non misura il prodotto, misura la macchina.
 * Cronometrato il 12/08/2026 su questo Mac con la board che dispaccia altri
 * agenti in parallelo (load 27-51), 10 aperture di shell: dal click al prompt
 * sono passati da 2,2 s a 75 s, e il prompt è arrivato TUTTE E DIECI le volte.
 * Quindi il rosso non dice «output perso», dice «la macchina era occupata»: la
 * cura è un budget più largo dove serve, non un a-capo mandato alla shell per
 * farle ristampare il prompt (quello sì nasconderebbe una perdita vera).
 */
/**
 * The GESTURE alone: «+» on the project row, then «Shell».         allow-italian: quoted UI string
 *
 * Split out of `openShellViaSidebar` because a spec about a REFUSED creation
 * needs the click without the wait that follows it: there will be no xterm, and
 * waiting fifteen seconds for one would report the setup instead of the bug.
 */
export async function clickAddShell(page: Page): Promise<void> {
  /* THE `title` ATTRIBUTE IS NOT STABLE WHILE THE MOUSE IS OVER THE ROW.
   *
   * `TooltipDelegate` (ec40c0932) moves the value of `title` onto `data-tip`
   * and removes the attribute on `mouseover`, so the native OS tooltip never
   * fires; it puts it back on `mouseout`. Playwright leaves the pointer where
   * it is after `hover()`, so from the SECOND call onwards this line was
   * looking for an attribute the first pass had already stripped. That is why
   * TERM-04 — the only case that opens two shells in a row — died where every
   * other consumer passed: the first open worked, the second did not.
   *
   * Matching both forms is not a patch: `data-tip` IS where the title lives
   * while the mouse is over the row, which is exactly the state this helper
   * works in. */
  const projectHeader = page.locator(projectRowSelector()).first();
  // The "+" is `opacity-0` until the row is hovered.
  await projectHeader.hover();
  const addBtn = projectHeader.locator("..").locator(labeledButton("Add to project")).first();
  await addBtn.waitFor({ state: "visible", timeout: 5000 });
  await addBtn.click();

  // Testid and not `getByRole("button", { name: "Shell" })`: PaneAddMenu rows
  // declare `role="menuitem"` inside a `role="menu"`, so the implicit button
  // role no longer exists. The testid is the stable contract.
  const shellBtn = page.getByTestId("pane-add-menu-shell");
  await shellBtn.waitFor({ state: "visible", timeout: 5000 });
  await shellBtn.click();
}

export async function openShellViaSidebar(
  page: Page,
  terminalPage: TerminalPage,
  readyTimeout = 15_000,
): Promise<void> {
  await clickAddShell(page);

  await expect(terminalPage.xtermRows.first()).toBeVisible({ timeout: readyTimeout });
  await terminalPage.waitForReady(readyTimeout);
}

/**
 * Il percorso completo: apri il progetto e ottieni una shell pronta al prompt.
 *
 * Se una shell è GIÀ a schermo la riusa invece di aprirne una seconda — una
 * sessione può essersi riconnessa da sola, e aprirne un'altra falserebbe i
 * conteggi delle tab.
 */
export async function navigateAndOpenTerminal(
  page: Page,
  terminalPage: TerminalPage,
  topicName: string,
): Promise<void> {
  await gotoTerminalProject(page, topicName);

  const alreadyVisible = await terminalPage.xtermRows
    .first()
    .isVisible()
    .catch(() => false);
  if (alreadyVisible) {
    await terminalPage.waitForReady();
    return;
  }

  await openShellViaSidebar(page, terminalPage);
}
