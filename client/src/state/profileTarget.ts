/**
 * APRIRE IL PROFILO SU UNA PAGINA PRECISA.
 *
 * Il pane «Profilo» ha tre pagine — chi sei, con chi stai, chi hai intorno — e
 * fino a ieri si apriva sempre sulla prima: chi cliccava «organizzazioni» in
 * fondo alla sidebar atterrava sul proprio profilo e doveva cercare la scheda.
 * Un collegamento che porta VICINO a dove hai chiesto e' un collegamento che
 * chiede un gesto in piu' ogni volta.
 *
 * PERCHE' UN VALORE E NON SOLO UN EVENTO. Il pane e' `lazy()`: quando parte la
 * richiesta il componente puo' non essere ancora montato, e un evento sparato
 * nel vuoto e' perso per sempre. Qui la richiesta si POSA, e chi monta la
 * raccoglie; l'evento serve al caso opposto, il pane gia' aperto che deve
 * cambiare scheda subito. I due casi sono entrambi veri, e uno solo dei due
 * meccanismi ne copre uno.
 *
 * LA RICHIESTA SI CONSUMA. Letta una volta, sparisce: senza, riaprire il
 * profilo un'ora dopo dal menu «Topics» lo riporterebbe sulla scheda che
 * qualcuno aveva chiesto in un altro momento, e sarebbe un pane che ricorda una
 * cosa che nessuno gli ha piu' detto.
 */
import type { SectionId } from '@/components/Settings/sections';

/** Le sole pagine che il pane Profilo conosce (`IDENTITY_SECTIONS`). */
export type PaginaProfilo = Extract<SectionId, 'profile' | 'organization' | 'friends'>;

export const EVENTO_PAGINA_PROFILO = 'topics:profile-page';

let richiesta: PaginaProfilo | null = null;

/**
 * Apre il pane Profilo su una pagina. Un gesto solo per chi chiama: la pagina
 * si posa qui, il pane si apre col bus che apre tutte le utility.
 */
export function apriProfilo(pagina: PaginaProfilo): void {
  richiesta = pagina;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'profile' } }));
  window.dispatchEvent(new CustomEvent(EVENTO_PAGINA_PROFILO, { detail: { pagina } }));
}

/** La pagina chiesta, una volta sola. `null` = nessuno ha chiesto niente. */
export function consumaPaginaProfilo(): PaginaProfilo | null {
  const p = richiesta;
  richiesta = null;
  return p;
}
