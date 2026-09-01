/**
 * OPENING THE PROFILE: on one particular page, and now on one particular PERSON.
 *
 * The "Profile" pane answers three questions (who you are, who follows you,
 * what you publish) and until yesterday it always opened on the first one,
 * always about yourself. Two defects, one mechanism:
 *
 *  - A link that gets you NEAR where you asked to go charges one extra gesture
 *    every single time. Clicking "followers" has to land on the followers,
 *    which today means the pane opens with that dropdown already open.
 *  - A person's face appeared in half a dozen places and was clickable in
 *    none of them. A name you cannot open is a dead end, and the profile it
 *    would have opened may as well not exist.
 *
 * WHY A VALUE AND NOT JUST AN EVENT. The pane is `lazy()`: when the request is
 * made the component may not be mounted yet, and an event fired into the void
 * is lost forever. Here the request is SET DOWN, and whoever mounts picks it
 * up; the event covers the opposite case, a pane already open that has to
 * switch straight away. Both cases are real, and each mechanism alone covers
 * only one of them.
 *
 * THE REQUEST EXPIRES. It answers for a few seconds and then it is gone:
 * without an end date, reopening the profile an hour later from the "Topics"
 * menu would drop you back on somebody else's page, asked for at some other
 * moment. It is a window and not a single read because the pane can mount
 * twice, and the first mount used to eat the request the second one needed.
 */
import type { SectionId } from '@/components/Settings/sections';

/** What can be asked of the Profile pane: the page, or one of its dropdowns. */
export type PageProfile = Extract<SectionId, 'profile' | 'followers' | 'privacy'>;

export const EVENTO_PAGINA_PROFILO = 'topics:profile-page';

/** What a caller can ask for: a page, a person, or both. */
export interface ProfileRequest {
  pagina: PageProfile;
  /** `null` = me. Anything else is somebody else's profile, read only. */
  personId: string | null;
}

/** The window in which the request is still answered. Long enough for a lazy
 *  chunk to arrive and for the pane to mount (twice, if the pane store rebuilds
 *  it), short enough that nobody can reach it from an unrelated later gesture. */
const VALID_MS = 5_000;

let richiesta: (ProfileRequest & { at: number }) | null = null;

function request(r: ProfileRequest, ora: number): void {
  richiesta = { ...r, at: ora };
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'profile' } }));
  window.dispatchEvent(new CustomEvent(EVENTO_PAGINA_PROFILO, { detail: r }));
}

/**
 * Opens the Profile pane on a page of YOUR OWN profile. One single gesture for
 * the caller: the page is set down here, the pane opens through the bus that
 * opens every utility.
 */
export function apriProfilo(pagina: PageProfile, ora = Date.now()): void {
  request({ pagina, personId: null }, ora);
}

/**
 * Opens SOMEBODY ELSE'S profile. This is the function every place that draws a
 * person calls: a presence row, a follower in a list, an avatar in a popover.
 * The page is always the overview, because that is what you wanted when you
 * clicked a face.
 */
export function openPersonProfile(personId: string, ora = Date.now()): void {
  request({ pagina: 'profile', personId }, ora);
}

/**
 * What was asked for, or `null` when nobody asked.
 *
 * IT EXPIRES, IT IS NOT EATEN BY THE FIRST READER. Destroying the request on
 * the first read looked tidier and it lost the request in the one case that
 * matters: the pane can MOUNT TWICE (the lazy chunk lands, the pane store
 * rebuilds the tab around it), and the second mount, the one left on screen,
 * read a request the first one had already swallowed. The visible symptom was a
 * deep link opening the profile on your own first page, which is the exact bug
 * the deep link was written to remove.
 */
export function requestedProfile(ora = Date.now()): ProfileRequest | null {
  if (!richiesta) return null;
  if (ora - richiesta.at > VALID_MS) {
    richiesta = null;
    return null;
  }
  return { pagina: richiesta.pagina, personId: richiesta.personId };
}

/** Just the page, for callers that do not care whose profile it is. */
export function paginaProfiloChiesta(ora = Date.now()): PageProfile | null {
  return requestedProfile(ora)?.pagina ?? null;
}

/** Forgets the request. The pane calls it once it has actually shown the page. */
export function dimenticaPaginaProfilo(): void {
  richiesta = null;
}
