import type { Page } from "@playwright/test";

/**
 * Helper condiviso per le pane utility (Dashboard, Board).
 *
 * Le pane utility hanno cambiato porta due volte: prima bottoni nella testata
 * standalone, poi il dropdown «Settings & Tools» (Topics ▾), oggi il menu «New»
 * (⌘N) come ogni altra pane.
 */

/**
 * Apre una pane UTILITY (Dashboard, Cron, Board) dal menu «New» della sidebar —
 * il «+» ⌘N, che è l'unico posto da cui si apre una pane.
 *
 * Stavano nel dropdown «Settings & Tools» (Topics ▾) con nomi loro
 * («Statistics», «Cron Jobs»); erano il menu «+» con altre etichette, e il
 * dropdown è tornato a essere solo vista + azioni di layout + Settings.
 *
 * Il locator è il `data-testid` della riga e non il nome accessibile: le righe
 * di `PaneAddMenu` sono `role="menuitem"` dentro un `role="menu"` (da baff80a5),
 * quindi `getByRole("button", …)` non le trova — stessa scelta di
 * `helpers/terminal-workspace.ts`. In più il testid non collide col bottone
 * omonimo nell'intestazione della pane, una volta che la pane è aperta e
 * sopravvive alla suite seriale.
 */
export async function openAddMenuPane(
  page: Page,
  type: "dashboard" | "board",
) {
  // By TESTID: the title contains the shortcut, which changes with the platform
  // (⌘N on a Mac, Ctrl+N elsewhere). See the note in dashboard.spec.ts.
  //
  // `.first()` IS THE SIDEBAR'S TRIGGER, and it is not a tolerance for a stray
  // duplicate. Once ANY pane is open the tab bar grows a second «+» carrying
  // the same testid, so from the second test of a file onwards - the pane store
  // survives between tests in the same worker - strict mode found two and threw
  // before the menu ever opened. The one that always exists, open panes or not,
  // is the one in the column.
  await page.getByTestId("pane-add-menu-trigger").first().click();
  const row = page.getByTestId(`pane-add-menu-${type}`);
  await row.waitFor({ state: "visible", timeout: 5000 });
  await row.click();
}
