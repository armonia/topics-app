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
    // open()'s contract is "the palette is now open". The global Cmd+K handler
    // occasionally drops the first synthetic keypress while focus is still
    // settling right after navigation, which surfaced as a flaky "palette not
    // visible". Press-then-wait with one retry; the 2.5s window is wide enough
    // that a slow-but-real open is caught BEFORE a second press (Cmd+K toggles,
    // so double-pressing an open palette would close it). A final waitFor still
    // throws a clear error if it genuinely never opens — so a real regression
    // (handler unbound) still fails the test rather than being masked.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.page.keyboard.press("Meta+k");
      if (await this.overlay.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false)) return;
    }
    await this.overlay.waitFor({ state: "visible", timeout: 3000 });
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
