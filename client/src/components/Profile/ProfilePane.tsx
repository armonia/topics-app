import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { ProfilePage, FollowersPage, PrivacyPage } from '../Settings/IdentityPages';
import { IDENTITY_SECTIONS, SETTINGS_SECTIONS, type SectionId } from '../Settings/sections';
import { dimenticaPaginaProfilo, EVENTO_PAGINA_PROFILO, requestedProfile, type ProfileRequest } from '@/state/profileTarget';
import { PersonProfile } from './PersonProfile';

/**
 * The "Profile" pane: the tab about who you are, who you are with, and who you
 * have around you.
 *
 * -- WHY A PANE AND NOT JUST A SETTINGS TAB -----------------------------------
 * The personal statistics only lived inside a modal: seeing them meant opening
 * preferences, finding the tab and scrolling. Something you look at often
 * deserves a tab of its own like Dashboard, not three gestures inside a window
 * that covers the app.
 *
 * -- WHY THREE SUB-PAGES AND NOT ONE SINGLE COLUMN ----------------------------
 * This pane used to stack four boxes in a row (statistics, Discord,
 * organisations, friends) and anybody after the organisation had to know it was
 * the third one down. It is the same flaw the Settings panel had, and the cure
 * is the same: three pages with one name each. The pages are LITERALLY the
 * settings ones (`Settings/IdentityPages`), so the two surfaces cannot diverge:
 * when the account showed up over there, it was missing here, and nobody had
 * noticed.
 *
 * -- THE PANE ALSO SHOWS OTHER PEOPLE -----------------------------------------
 * Ask for a person and the three pages step aside for THEIR profile, with a way
 * back to your own. It is the same tab because it is the same subject: opening
 * a face in a second window would mean two places that answer "who is this",
 * and the sidebar already learned how that ends.
 */
export function ProfilePane() {
  const t = useT();
  // The page asked for by whoever opened the pane, if anybody asked at all. It
  // is read on mount (the pane is `lazy()`: when the request is made this
  // component may not exist yet) and the event covers the opposite case, a pane
  // already open that has to change tab under the click.
  const requested = requestedProfile();
  const [pagina, setPagina] = useState<SectionId>(() => requested?.pagina ?? 'profile');
  // The person being looked at, `null` for your own profile. It is state and
  // not a prop because the pane outlives every gesture that changes it.
  const [personId, setPersonId] = useState<string | null>(() => requested?.personId ?? null);

  useEffect(() => {
    const go = (e: Event) => {
      const chiesta = (e as CustomEvent<ProfileRequest>).detail;
      if (!chiesta?.pagina) return;
      setPagina(chiesta.pagina);
      setPersonId(chiesta.personId ?? null);
      dimenticaPaginaProfilo();
    };
    window.addEventListener(EVENTO_PAGINA_PROFILO, go as EventListener);
    return () => window.removeEventListener(EVENTO_PAGINA_PROFILO, go as EventListener);
  }, []);

  return (
    <div data-testid="profile-pane" className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* THE IDENTITY BAND IS NOT HERE, and that is not an oversight.
          It lives at the bottom of the sidebar (`Sidebar/SidebarStatusBar`),
          which is where you look at it while you work: nobody opens a tab to
          find out who is around right now. The profile is still a tab like any
          other — it opens from the menu, it gets its row in the column, it
          closes — but its pages say the same subjects AT LENGTH, and repeating
          the live strip here would render it twice in the same app: two
          `identity-block` in the DOM, and every measurement that looks for one
          becomes ambiguous. */}
      {/* The three entries ARE the heading: there is no pane title above them
          repeating the word "Profile" while you are looking at "Friends". */}
      <div
        className="flex flex-shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-app-border px-3 py-2"
        role="tablist"
        aria-label="Profilo"
      >
        {IDENTITY_SECTIONS.map((id) => {
          const voce = SETTINGS_SECTIONS.find((s) => s.id === id);
          if (!voce) return null;
          const Icon = voce.icon;
          const attiva = personId === null && pagina === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={attiva}
              onClick={() => { setPersonId(null); setPagina(id); }}
              data-testid={`profile-tab-${id}`}
              className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] transition-colors coarse:min-h-11 ${
                attiva
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
              }`}
            >
              <Icon size={14} className="flex-shrink-0" />
              {t(voce.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-5">
        {personId !== null ? (
          <PersonProfile personId={personId} onBack={() => setPersonId(null)} />
        ) : (
          <>
            {pagina === 'profile' && <ProfilePage />}
            {pagina === 'followers' && <FollowersPage />}
            {pagina === 'privacy' && <PrivacyPage />}
          </>
        )}
      </div>
    </div>
  );
}
