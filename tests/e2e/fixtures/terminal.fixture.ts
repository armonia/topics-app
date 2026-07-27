import { test as base, type Page, type Locator, expect } from "@playwright/test";

export class TerminalPage {
  constructor(private page: Page) {}

  get panel() { return this.page.locator('[data-testid="terminal-panel"]'); }
  // Inactive panes stay MOUNTED with display:none, so a bare `.xterm-rows`
  // (or `.first()`) can resolve to a hidden leftover pane. Scope to :visible so
  // locators always land on the terminal that's actually on screen.
  get xtermRows() { return this.page.locator('.xterm-rows:visible'); }
  get newTerminalBtn() { return this.page.locator('[data-testid="terminal-new-btn"]'); }

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

  /** Open a new shell terminal via the "+" button dropdown */
  async openNewShell() {
    await this.newTerminalBtn.click();
    await this.page.getByRole('button', { name: 'Shell' }).click();
    await expect(this.xtermRows.first()).toBeVisible({ timeout: 15_000 });
  }

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
