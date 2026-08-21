/**
 * OPENING THE PROFILE ON ONE PARTICULAR PAGE.
 *
 * The "Profile" pane has three pages (who you are, who you are with, who is
 * around you) and until yesterday it always opened on the first one: clicking
 * "organisations" at the bottom of the sidebar landed you on your own profile,
 * with the tab still to find. A link that gets you NEAR where you asked to go
 * is a link that charges one extra gesture every single time.
 *
 * WHY A VALUE AND NOT JUST AN EVENT. The pane is `lazy()`: when the request is
 * made the component may not be mounted yet, and an event fired into the void
 * is lost forever. Here the request is SET DOWN, and whoever mounts picks it
 * up; the event covers the opposite case, a pane already open that has to
 * switch tab straight away. Both cases are real, and each mechanism alone
 * covers only one of them.
 *
 * THE REQUEST EXPIRES. It answers for a few seconds and then it is gone:
 * without an end date, reopening the profile an hour later from the "Topics"
 * menu would drop you back on the tab somebody asked for at some other moment,
 * which is a pane remembering something nobody has told it since. It is a
 * window and not a single read because the pane can mount twice, and the first
 * mount used to eat the request the second one needed.
 */
import type { SectionId } from '@/components/Settings/sections';

/** The only pages the Profile pane knows about (`IDENTITY_SECTIONS`). */
export type PaginaProfilo = Extract<SectionId, 'profile' | 'organization' | 'friends'>;

export const EVENTO_PAGINA_PROFILO = 'topics:profile-page';

/** The window in which the request is still answered. Long enough for a lazy
 *  chunk to arrive and for the pane to mount (twice, if the pane store rebuilds
 *  it), short enough that nobody can reach it from an unrelated later gesture. */
const VALIDA_MS = 5_000;

let richiesta: { pagina: PaginaProfilo; at: number } | null = null;

/**
 * Opens the Profile pane on a page. One single gesture for the caller: the page
 * is set down here, the pane opens through the bus that opens every utility.
 */
export function apriProfilo(pagina: PaginaProfilo, ora = Date.now()): void {
  richiesta = { pagina, at: ora };
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'profile' } }));
  window.dispatchEvent(new CustomEvent(EVENTO_PAGINA_PROFILO, { detail: { pagina } }));
}

/**
 * The page that was asked for, or `null` when nobody asked.
 *
 * IT EXPIRES, IT IS NOT EATEN BY THE FIRST READER. Destroying the request on
 * the first read looked tidier and it lost the request in the one case that
 * matters: the pane can MOUNT TWICE (the lazy chunk lands, the pane store
 * rebuilds the tab around it), and the second mount, the one left on screen,
 * read a request the first one had already swallowed. The visible symptom was
 * "Manage this organization" opening the profile on your own page, which is the
 * exact bug the deep link was written to remove.
 *
 * The time window keeps the other half of the promise: reopening the profile
 * from the "Topics" menu an hour later must not land on a page somebody asked
 * for at some other moment.
 */
export function paginaProfiloChiesta(ora = Date.now()): PaginaProfilo | null {
  if (!richiesta) return null;
  if (ora - richiesta.at > VALIDA_MS) {
    richiesta = null;
    return null;
  }
  return richiesta.pagina;
}

/** Forgets the request. The pane calls it once it has actually shown the page. */
export function dimenticaPaginaProfilo(): void {
  richiesta = null;
}
