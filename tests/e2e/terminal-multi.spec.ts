import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  gotoTerminalProject,
  openShellViaSidebar,
} from "./helpers/terminal-workspace";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);
/**
 * IL TERMINALE HA BISOGNO DI PIU' DEI 30 SECONDI DI DEFAULT.
 *
 * Non e' generosita': e' una misura. Questi casi aprono una PTY vera, aspettano
 * il ponte WebSocket e poi che xterm.js dipinga - da soli fanno 19 secondi, cioe'
 * gia' due terzi del tetto. Dentro uno shard, con un solo worker e la macchina
 * carica, arrivano a 36-42 e sforano.
 *
 * Misurato il 17/08 su TRE corse complete della suite: i test del terminale
 * cadevano in tutte e tre (`TERM-01`, `TERM-02`, `TERM-04`, reconnect,
 * idle-park), ma bersagli DIVERSI ogni volta e tutti verdi rieseguiti da soli.
 * Un rosso che cambia bersaglio non e' una regressione: e' un tetto troppo
 * stretto per il lavoro che c'e' dentro.
 *
 * 75 secondi, non un numero rotondo a caso: il peggiore misurato e' 42s sotto
 * carico, e questo lascia il margine per una macchina piu' lenta senza
 * trasformare un test appeso in cinque minuti di attesa. Se un giorno un caso
 * qui dentro impiega davvero 75 secondi, il problema non e' il tetto.
 */
test.describe.configure({ timeout: 75_000 });


/**
 * TERM-04: due terminali aperti insieme, e lo scambio fra le loro tab.
 *
 * La famiglia terminale sta in tre file — `terminal`, `terminal-reconnect`,
 * `terminal-multi` — che prima erano tre `describe` dentro un unico file da 76
 * secondi. Poiche' Playwright distribuisce gli shard PER FILE, quei 76 secondi
 * erano un pavimento sotto cui il wall-clock non poteva scendere con nessun
 * numero di shard. La procedura condivisa (apri il progetto, "+" -> Shell,
 * aspetta il prompt) vive in `helpers/terminal-workspace.ts`: era ricopiata
 * tre volte, gia' divergente fra le copie.
 */
test.describe("Terminal Multi-Instance", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "multi"));
  });

  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("TERMUI-04: multiple terminal instances can be opened and switched", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await gotoTerminalProject(page, topicName);

    // Prima shell. Qui si usa `openShellViaSidebar` e non
    // `navigateAndOpenTerminal`: quest'ultima RIUSA una shell gia' a schermo, ed
    // e' esattamente cio' che questo test non vuole — gliene servono DUE.
    await openShellViaSidebar(page, terminalPage);

    // Type unique marker in terminal 1
    await terminalPage.focus();
    const marker1 = `term1-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker1}`);
    await terminalPage.waitForOutput(marker1);

    // Open second terminal
    await openShellViaSidebar(page, terminalPage);

    // Type unique marker in terminal 2
    await terminalPage.focus();
    const marker2 = `term2-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker2}`);
    await terminalPage.waitForOutput(marker2);

    // Verify there are at least 2 terminal/shell tabs in the pane tab bar
    // Terminal panes have title "Shell" and show in the last panel-tab-bar
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    // Each pane tab is a div containing a span with the pane title; filter those with "Shell"
    const shellTabs = tabBar.locator('[data-testid^="pane-tab-terminal:"]');
    await expect(shellTabs).toHaveCount(2, { timeout: 5000 });

    // Switch to terminal 1 by clicking the first Shell tab
    await shellTabs.first().click();

    // Wait for terminal 1 content to be visible with marker1
    await expect(async () => {
      const text = await terminalPage.getTerminalText();
      expect(text).toContain(marker1);
    }).toPass({ timeout: 10_000 });

    // Switch to terminal 2 by clicking the second Shell tab
    await shellTabs.last().click();

    // Wait for terminal 2 content to be visible with marker2
    await expect(async () => {
      const text = await terminalPage.getTerminalText();
      expect(text).toContain(marker2);
    }).toPass({ timeout: 10_000 });
  });
});
