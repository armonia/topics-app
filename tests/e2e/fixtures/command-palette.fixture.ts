import { test as base, type Page } from "@playwright/test";

export class CommandPalettePage {
  constructor(private page: Page) {}

  get overlay() {
    return this.page.locator('[data-testid="command-palette"]');
  }

  get searchInput() {
    return this.overlay.getByRole("textbox");
  }

  async open() {
    await this.page.keyboard.press("Meta+k");
  }

  async close() {
    await this.page.keyboard.press("Escape");
  }

  async search(query: string) {
    await this.open();
    await this.searchInput.fill(query);
  }

  async selectResult(index: number) {
    for (let i = 0; i < index; i++) {
      await this.page.keyboard.press("ArrowDown");
    }
    await this.page.keyboard.press("Enter");
  }
}

export const test = base.extend<{ commandPalettePage: CommandPalettePage }>({
  commandPalettePage: async ({ page }, use) => {
    await use(new CommandPalettePage(page));
  },
});
