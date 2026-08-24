import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  TERMINAL_PROJECT_PATH as projectPath,
  resetTerminalWorkspace,
  seedTerminalTopic,
  cleanupTerminalTopic,
  navigateAndOpenTerminal,
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
 * Il terminale: apertura, input, cwd, resize, scrollback, chiusura e focus.
 *
 * La famiglia terminale sta in tre file — `terminal`, `terminal-reconnect`,
 * `terminal-multi` — che prima erano tre `describe` dentro un unico file da 76
 * secondi. Poiche' Playwright distribuisce gli shard PER FILE, quei 76 secondi
 * erano un pavimento sotto cui il wall-clock non poteva scendere con nessun
 * numero di shard. La procedura condivisa (apri il progetto, "+" -> Shell,
 * aspetta il prompt) vive in `helpers/terminal-workspace.ts`: era ricopiata
 * tre volte, gia' divergente fra le copie.
 */
test.describe.serial("Terminal", () => {
  let topicId = "";
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "main"));
  });

  test.beforeEach(async ({ request }) => {
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupTerminalTopic(request, topicId);
  });

  test("TERMUI-01: terminal opens and xterm.js renders with WebSocket connection", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // Verify xterm.js DOM renderer created .xterm-rows
    await expect(terminalPage.xtermRows.first()).toBeVisible();

    // Verify shell prompt appeared (already verified in navigateAndOpenTerminal)
    // Additional check: terminal tab is visible in the pane tab bar
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await expect(tabBar).toBeVisible();
  });

  test("TERMUI-02: terminal accepts keyboard input and shows output", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // Click terminal to focus
    await terminalPage.focus();

    // Type a command with a unique marker
    const marker = `e2e-term-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker}`);

    // Verify output contains the marker (auto-retry handles async terminal rendering)
    await terminalPage.waitForOutput(marker);
  });

  test("TERMUI-05: terminal opens with correct project cwd", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // Click terminal to focus
    await terminalPage.focus();

    // Run pwd to check working directory
    const marker = `pwd-marker-${Date.now()}`;
    await terminalPage.typeCommand(`pwd && echo ${marker}`);

    // Wait for marker to ensure command completed
    await terminalPage.waitForOutput(marker);

    // Verify the project path appears in output
    // On macOS, /tmp is a symlink to /private/tmp, so check for both
    const text = await terminalPage.getTerminalText();
    const hasProjectPath =
      text.includes(projectPath) || text.includes(`/private${projectPath}`);
    expect(hasProjectPath).toBeTruthy();
  });

  test("TERMUI-06: terminal resizes when pane dimensions change", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // Record initial xterm screen width
    const initialWidth = await page.evaluate(
      () => document.querySelector(".xterm-screen")?.getBoundingClientRect().width,
    );
    expect(initialWidth).toBeTruthy();

    // Resize viewport to a smaller width
    await page.setViewportSize({ width: 800, height: 600 });

    // Il fit addon reagisce a un ResizeObserver: si POLLA la larghezza finche'
    // cambia, invece di dormire 500ms al buio. L'attesa fissa era sbagliata in
    // entrambe le direzioni — spreca mezzo secondo quando il resize arriva in
    // 30ms, e non basta su una macchina carica, dove il test fallisce dicendo
    // "la larghezza non e' cambiata" mentre stava solo per cambiare.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector(".xterm-screen")?.getBoundingClientRect().width,
          ),
        { timeout: 10_000 },
      )
      .not.toBe(initialWidth);

    const newWidth = await page.evaluate(
      () => document.querySelector(".xterm-screen")?.getBoundingClientRect().width,
    );
    expect(newWidth).toBeTruthy();
  });

  test("TERMUI-07: terminal preserves scrollback buffer", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    await terminalPage.focus();

    // Generate enough output to fill visible area and create scrollback
    const marker = `scrollback-end-${Date.now()}`;
    await terminalPage.typeCommand(`for i in $(seq 1 50); do echo line-$i; done && echo ${marker}`);

    // Wait for the last line to confirm command completed
    await terminalPage.waitForOutput(marker);

    // The terminal text should contain earlier lines (scrollback preserved)
    // xterm.js innerText includes the scrollback buffer content
    await expect(async () => {
      const text = await terminalPage.getTerminalText();
      expect(text).toContain("line-50");
    }).toPass({ timeout: 5_000 });
  });

  test("TERMUI-08: closing terminal tab removes it from tab bar", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // Locate the Shell tab in the pane tab bar. Post-redesign the shell tab is
    // auto-named basename(cwd) (server/routes/terminal.ts:1019-1022), never "Shell",
    // so match by the terminal pane-tab testid instead of the literal title.
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    const shellTab = tabBar.locator('[data-testid^="pane-tab-terminal:"]').first();
    await expect(shellTab).toBeVisible();

    // Hover over the Shell tab to reveal the close button
    await shellTab.hover();

    // Click the close button (X icon that appears on hover)
    const closeBtn = shellTab.locator("button").first();
    await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
    await closeBtn.click();

    // Verify the Shell tab is no longer visible in the tab bar
    await expect(shellTab).not.toBeVisible({ timeout: 5_000 });
  });

  test("TERMUI-09: terminal handles rapid input", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    await terminalPage.focus();

    // Type a long string rapidly (5ms between chars)
    const rapidText = "abcdefghijklmnopqrstuvwxyz1234567890";
    const marker = `rapid-${Date.now()}`;
    await page.keyboard.type(`echo ${rapidText} && echo ${marker}`, { delay: 5 });
    await page.keyboard.press("Enter");

    // Wait for marker to confirm command completed
    await terminalPage.waitForOutput(marker);

    // Verify the full string appears in terminal output
    const text = await terminalPage.getTerminalText();
    expect(text).toContain(rapidText);
  });

  test("TERMUI-10: terminal focus by clicking", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage, topicName);

    // Click somewhere else to unfocus the terminal (e.g., the sidebar)
    const sidebar = page.locator('[data-testid="sidebar"]').or(
      page.locator(".sidebar"),
    ).first();
    if (await sidebar.isVisible()) {
      await sidebar.click({ position: { x: 10, y: 10 } });
    }

    // Click the terminal area to restore focus
    await terminalPage.focus();

    // Type a command to verify focus was restored
    const marker = `focus-test-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker}`);

    // Verify the command executed (focus was successfully restored by clicking)
    await terminalPage.waitForOutput(marker);
  });
});
