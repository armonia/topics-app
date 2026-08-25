/**
 * IL SECONDO BROWSER DEVE NASCERE.
 *
 * Guasto riportato (12/08/2026): con un progetto aperto, «+ → Browser» la prima
 * volta apre la pane; la SECONDA volta non fa niente — nessuna tab nuova,
 * nessun messaggio. Misurato: il «+» della barra STANDALONE chiamava
 * `ensureBrowserPane()` SENZA contextId, e il riduttore singleton
 * (usePaneOrdering.browserSingletonReducer, caso 2) riusa il primo browser che
 * trova. La sidebar e il «+» dentro la finestra di progetto invece un contesto
 * ce l'hanno, e infatti lì la seconda pane nasceva: due porte, due politiche.
 *
 * Qui si misura la sola cosa osservabile — quante tab `browser:*` esistono dopo
 * due click sulla stessa voce — su ENTRAMBE le barre.
 *
 * @covers BROWSER-CHAT-04
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goToApp } from "./helpers";
import { resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PROJECT_PATH = join(tmpdir(), `e2e-second-browser-${Date.now()}`);

/** Apre il menu «+» della barra indicata e sceglie Browser.
 *  `which`: 'standalone' = la barra in cima (quella che ospita la tab del
 *  progetto), 'project' = quella dentro la finestra di progetto. */
async function addBrowser(page: Page, which: "standalone" | "project"): Promise<void> {
  const plus = page.locator('[title="Add pane"]');
  await (which === "standalone" ? plus.first() : plus.last()).click();
  await expect(page.locator('[data-testid="pane-add-menu"]').first()).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("pane-add-menu-browser").first().click();
}

/** Le tab browser di UNA barra sola: contarle su tutta la pagina mescolerebbe
 *  le due superfici. */
function browserTabsIn(page: Page, which: "standalone" | "project") {
  const bars = page.locator('[data-testid="panel-tab-bar"]');
  const bar = which === "standalone" ? bars.first() : bars.last();
  return bar.locator('[data-pane-id^="browser:"]');
}

async function openProjectWithSeededPane(page: Page): Promise<void> {
  await resetPaneStore(page.request, []);
  await resetProjectPanes(page.request, PROJECT_PATH);
  await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  await goToApp(page);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 15_000 });
}

test.describe.serial("Due pane browser nello stesso gruppo", () => {
  test.beforeAll(() => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-second-browser" }, null, 2));
  });

  test.afterAll(() => {
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test("barra standalone: il secondo «+ → Browser» apre una seconda tab", async ({ page }) => {
    await openProjectWithSeededPane(page);
    const tabs = browserTabsIn(page, "standalone");

    await addBrowser(page, "standalone");
    await expect(tabs).toHaveCount(1, { timeout: 10_000 });

    await addBrowser(page, "standalone");
    await expect(tabs).toHaveCount(2, { timeout: 10_000 });
  });

  test("finestra di progetto: due «+ → Browser» danno due tab nel gruppo", async ({ page }) => {
    await openProjectWithSeededPane(page);

    await addBrowser(page, "project");
    await expect(browserTabsIn(page, "project")).toHaveCount(1, { timeout: 10_000 });

    await addBrowser(page, "project");
    await expect(browserTabsIn(page, "project")).toHaveCount(2, { timeout: 10_000 });
  });
});
