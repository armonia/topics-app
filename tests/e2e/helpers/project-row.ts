import type { Locator, Page } from "@playwright/test";

/**
 * LA RIGA DI UN PROGETTO NELLA SIDEBAR — cercata per RUOLO, non per testo.
 *
 * Sei spec avevano ognuna la propria copia di:
 *
 *     page.locator('[aria-label="Topics sidebar"] button')
 *         .filter({ hasText: /e2e-qualcosa/ }).first()
 *
 * cioè «il primo bottone DELLA COLONNA che contenga quel testo». Ha funzionato
 * finché il nome di un progetto compariva in un posto solo — e ha smesso il
 * 07/08, quando la riga «Board» ha cominciato a mostrare i progetti con task
 * aperti (icona + nome + conteggio, `BoardProjectChips`). Da quel momento due
 * bottoni contengono `e2e-board-…`: la riga del progetto e la riga della board,
 * che nel DOM viene PRIMA. `.first()` prendeva quella, il clic apriva la board
 * generale invece della finestra di progetto, e quindici test morivano su
 * `project-window` «hidden» — accusando il componente sbagliato.
 *
 * `hasText` con una RegExp guarda il `textContent`, discendenti compresi: è la
 * stessa trappola già registrata in questo repo. La correzione non è restringere
 * la regex (il prossimo posto che nomina un progetto la romperebbe di nuovo): è
 * smettere di identificare una riga dal testo che porta. `project-toggle-<nome>`
 * è il testid che quella riga ha da sempre — un appiglio che dice COSA sei, non
 * cosa c'è scritto sopra.
 */
export function projectRow(page: Page, name: RegExp | string): Locator {
  return page
    .locator('[aria-label="Topics sidebar"] [data-testid^="project-toggle-"]')
    .filter({ hasText: name })
    .first();
}
