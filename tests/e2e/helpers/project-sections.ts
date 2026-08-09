import { expect, type Page } from "@playwright/test";

/**
 * Apre una sezione della barra di progetto — File, Git o Processi.
 *
 * Le tre stavano impilate e aperte insieme, quindi `GitChanges` era montata
 * SEMPRE e bastava cercarla. Ora stanno in una riga di chip sopra un pannello
 * solo, ne vive una alla volta, e il suo contenuto esiste solo da aperta: chi
 * lo cerca deve prima chiederlo. Idempotente — il chip è un toggle, e
 * cliccarlo alla cieca su una sezione già aperta la richiude.
 */
export async function apriSezioneProgetto(page: Page, id: "files" | "git" | "processes") {
  const chip = page.getByTestId(`project-sidebar-${id}`).first();
  await expect(chip, `chip della sezione ${id}`).toBeVisible({ timeout: 15000 });
  if ((await chip.getAttribute("aria-expanded")) !== "true") {
    await chip.click();
  }
  await expect(chip, `la sezione ${id} deve risultare aperta`).toHaveAttribute("aria-expanded", "true", { timeout: 5000 });
}
