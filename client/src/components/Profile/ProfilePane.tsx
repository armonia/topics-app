import { useEffect, useState } from 'react';
import { dimenticaPaginaProfilo, EVENTO_PAGINA_PROFILO, requestedProfile, type PageProfile, type ProfileRequest } from '@/state/profileTarget';
import { PersonProfile } from './PersonProfile';
import { SelfProfile, type ProfilePanel } from './SelfProfile';

/**
 * The "Profile" pane: ONE page about a person, and nothing else.
 *
 * -- WHY A PANE AND NOT JUST A SETTINGS TAB -----------------------------------
 * A profile is something you look at often, and reaching it meant opening
 * preferences, finding a tab and scrolling. Something read that often deserves
 * a tab of its own like Dashboard, not three gestures inside a window that
 * covers the app.
 *
 * -- THE TAB STRIP IS GONE, AND THAT IS THE POINT -----------------------------
 * The pane used to hold three sub-pages (profile, followers, privacy) drawn as
 * a strip of tabs, and the first of them opened on the shareable banner, the
 * public link, Discord and the account. Two different mistakes in one surface:
 * a public profile does not have TABS (nobody reads a person by picking a
 * chapter), and it does not carry the configuration of the installation it
 * happens to run on. What is left is the page a stranger would get; followers
 * and privacy open as dropdowns from the exact spot that raises them, and the
 * configuration lives in Settings, which is where configuration belongs.
 *
 * -- THE PANE ALSO SHOWS OTHER PEOPLE -----------------------------------------
 * Ask for a person and the page becomes THEIRS, with a way back to your own. It
 * is the same tab because it is the same subject: opening a face in a second
 * window would mean two places that answer "who is this", and the sidebar
 * already learned how that ends.
 */

/**
 * A requested page becomes an open dropdown. The deep links did not change
 * (`apriProfilo('followers' | 'privacy')` from the sidebar): what changed is
 * what they open on. "Followers" lands on the people window at its own default
 * tab, which is friends, because the link that sends people here is the one
 * reading "manage friends".
 */
function panelFor(pagina: PageProfile | undefined): ProfilePanel {
  if (pagina === 'privacy') return 'privacy';
  if (pagina === 'followers') return 'friends';
  return null;
}

export function ProfilePane() {
  // The request made by whoever opened the pane, if anybody made one. It is
  // read on mount (the pane is `lazy()`: when the request is made this
  // component may not exist yet) and the event covers the opposite case, a pane
  // already open that has to change under the click.
  const requested = requestedProfile();
  // The person being looked at, `null` for your own profile. It is state and
  // not a prop because the pane outlives every gesture that changes it.
  const [personId, setPersonId] = useState<string | null>(() => requested?.personId ?? null);
  const [panel, setPanel] = useState<ProfilePanel>(() => panelFor(requested?.pagina));

  useEffect(() => {
    const go = (e: Event) => {
      const chiesta = (e as CustomEvent<ProfileRequest>).detail;
      if (!chiesta?.pagina) return;
      setPersonId(chiesta.personId ?? null);
      setPanel(panelFor(chiesta.pagina));
      dimenticaPaginaProfilo();
    };
    window.addEventListener(EVENTO_PAGINA_PROFILO, go as EventListener);
    return () => window.removeEventListener(EVENTO_PAGINA_PROFILO, go as EventListener);
  }, []);

  // Escape closes the open dropdown, like every other menu here. Without it the
  // only way out of a panel opened by a deep link is finding its cross.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div data-testid="profile-pane" className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* THE IDENTITY BAND IS NOT HERE, and that is not an oversight.
          It lives at the bottom of the sidebar (`Sidebar/SidebarStatusBar`),
          which is where you look at it while you work: nobody opens a tab to
          find out who is around right now. Repeating the live strip here would
          render it twice in the same app: two `identity-block` in the DOM, and
          every measurement that looks for one becomes ambiguous. */}
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-5">
        {personId !== null ? (
          <PersonProfile personId={personId} onBack={() => setPersonId(null)} />
        ) : (
          <SelfProfile open={panel} onOpen={setPanel} />
        )}
      </div>
    </div>
  );
}
