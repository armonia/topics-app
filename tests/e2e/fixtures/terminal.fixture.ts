import { test as base, type Page, type Locator, expect } from "@playwright/test";

export class TerminalPage {
  constructor(private page: Page) {}

  get panel() { return this.page.locator('[data-testid="terminal-panel"]'); }
  // Inactive panes stay MOUNTED with display:none, so a bare `.xterm-rows`
  // (or `.first()`) can resolve to a hidden leftover pane. Scope to :visible so
  // locators always land on the terminal that's actually on screen.
  get xtermRows() { return this.page.locator('.xterm-rows:visible'); }

  /** Get visible xterm rows scoped to the active (displayed) terminal */
  get activeXtermRows() {
    return this.page.locator('.xterm-rows:visible').first();
  }

  /** Get all terminal text from the active terminal */
  async getTerminalText(): Promise<string> {
    return this.activeXtermRows.evaluate((el) => (el as HTMLElement).innerText);
  }

  /** Type a command into the focused terminal (xterm captures keyboard directly) */
  async typeCommand(command: string) {
    await this.page.keyboard.type(command + '\n');
  }

  /** Wait for terminal output to contain text (auto-retry) */
  async waitForOutput(text: string | RegExp, timeout = 15_000) {
    await expect(this.activeXtermRows).toContainText(text, { timeout });
  }

  /** Click terminal to ensure it has focus before typing.
   *  xterm.js v6 uses .xterm-screen as the interactive layer above .xterm-rows */
  async focus() {
    await this.page.locator('.xterm-screen:visible').first().click();
  }

  // `openNewShell()` viveva qui e non lo chiamava nessuno. Era rotto in DUE
  // punti — il `terminal-new-btn` che cliccava non esiste più nel client, e il
  // `getByRole('button', { name: 'Shell' })` era morto da baff80a5, quando le
  // righe del menu «+» sono passate a `role="menuitem"`. Rimosso invece che
  // aggiustato: la procedura vera è `openShellViaSidebar` in
  // helpers/terminal-workspace.ts, che passa dal testid `pane-add-menu-shell` e
  // la usano davvero terminal-multi / terminal-reconnect. Un secondo modo di
  // aprire una shell, non esercitato da nessuno, è solo un posto in più dove la
  // prossima rinomina si rompe in silenzio — ed è appena successo: la riga ora
  // si chiama «Terminale».

  /** Wait for terminal to be ready (xterm rows visible + shell prompt character) */
  async waitForReady(timeout = 15_000) {
    await expect(this.activeXtermRows).toBeVisible({ timeout });
    await expect(this.activeXtermRows).toContainText(/[$%#>]/, { timeout });
  }

  /** Click a specific terminal tab by session ID */
  async switchToTab(sessionId: string) {
    await this.page.locator(`[data-testid="terminal-tab-${sessionId}"]`).click();
  }
}

export const test = base.extend<{ terminalPage: TerminalPage }>({
  terminalPage: async ({ page }, use) => {
    await use(new TerminalPage(page));
  },
});
