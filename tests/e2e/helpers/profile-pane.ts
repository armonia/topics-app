import { expect, type Page } from "@playwright/test";

/**
 * Open the Profile TAB and wait for it.
 *
 * LA FASCIA IDENTITA' NON STA QUI, e questo helper non serve a raggiungerla:
 * quelle tre righe sono rimaste in fondo alla sidebar, sempre a schermo, e le
 * spec che le misurano (org-presence) non aprono nessuna tab. Questo helper
 * serve alle spec che parlano del PROFILO come tab - le sue pagine, i follower,
 * la privacy - che senza aprirlo non hanno niente da guardare.
 *
 * Through the same bus the "+" menu and the Topics menu use, not through the
 * menu itself: what these specs are about is the identity, and driving three
 * clicks to get there would make them red for a reason that is not theirs.
 */
export async function apriPaneProfilo(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "profile" } })),
  );
  await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
}
