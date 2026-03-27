import { test as base, type Page } from "@playwright/test";

export class TerminalPage {
  constructor(private page: Page) {}

  get container() {
    return this.page.locator('[data-testid="terminal-container"]');
  }

  get xtermRows() {
    return this.page.locator(".xterm-rows");
  }

  async getTerminalText(): Promise<string> {
    return this.xtermRows.evaluate((el) => el.innerText);
  }
}

export const test = base.extend<{ terminalPage: TerminalPage }>({
  terminalPage: async ({ page }, use) => {
    await use(new TerminalPage(page));
  },
});
