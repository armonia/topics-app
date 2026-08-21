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
 * THE REQUEST IS CONSUMED. Read once, it disappears: without that, reopening
 * the profile an hour later from the "Topics" menu would drop you back on the
 * tab somebody asked for at some other moment, which is a pane remembering
 * something nobody has told it since.
 */
import type { SectionId } from '@/components/Settings/sections';

/** The only pages the Profile pane knows about (`IDENTITY_SECTIONS`). */
export type PaginaProfilo = Extract<SectionId, 'profile' | 'organization' | 'friends'>;

export const EVENTO_PAGINA_PROFILO = 'topics:profile-page';

let richiesta: PaginaProfilo | null = null;

/**
 * Opens the Profile pane on a page. One single gesture for the caller: the page
 * is set down here, the pane opens through the bus that opens every utility.
 */
export function apriProfilo(pagina: PaginaProfilo): void {
  richiesta = pagina;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'profile' } }));
  window.dispatchEvent(new CustomEvent(EVENTO_PAGINA_PROFILO, { detail: { pagina } }));
}

/** The requested page, once only. `null` means nobody asked for anything. */
export function consumaPaginaProfilo(): PaginaProfilo | null {
  const p = richiesta;
  richiesta = null;
  return p;
}
