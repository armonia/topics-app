/**
 * PEOPLE INSIDE A PANEL: the list, one person, a stack of faces, and the row
 * that leads out of the panel.
 *
 * They were four local helpers of the identity band, which drew three chips and
 * three dropdowns. The band is one card now, and its dropdown is the profile
 * menu (`ProfileMenu`), so these four moved out of that file and became the
 * shared vocabulary the menu speaks: friends, the members of a group and the
 * faces on a section header are the SAME rows, and drawing them twice is how a
 * dot ends up green in one list and grey in the other.
 */
import { ChevronRight } from 'lucide-react';
import { PALLINO_OK } from './chromeSignals';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { openPersonProfile } from '@/state/profileTarget';
import type { PresenceFace, PresenceRow } from './orgPresence';
import { useT } from '@/hooks/useT';

/** How many faces are shown before switching to a number. Past four they are
 *  indistinguishable dots, each as wide as the word that would count them. */
const MAX_FACES = 4;

/**
 * THE LIST OF PEOPLE inside a panel: present on top, absent below.
 *
 * The two groups are separated by a label and not only by the colour of the
 * dot: the colour states one ROW, the label states where the group you are
 * scrolling ends, which is the information you need when the rows are twenty
 * and the first three are green.
 *
 * A CAP AND A SCROLL, not the whole list: an organisation with forty people
 * would make the panel taller than the window, and `computeMenuPosition` would
 * glue it to the edge. Seven rows and a half is the point where you can see
 * there is more below without the panel turning into a page.
 */
export function PresenceList({ people, empty, hint }: {
  people: PresenceRow[];
  empty: string;
  hint?: string;
}) {
  const tr = useT();
  if (people.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-app-text-muted">
        <div>{empty}</div>
        {hint && <div className="mt-0.5 text-app-text-muted/80">{hint}</div>}
      </div>
    );
  }
  const here = people.filter((p) => p.presente);
  const away = people.filter((p) => !p.presente);
  return (
    <div className="max-h-[188px] overflow-y-auto py-1">
      {here.map((p) => <PresencePerson key={p.id} p={p} />)}
      {away.length > 0 && (
        <>
          {here.length > 0 && (
            <div className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-app-text-muted">
              {tr('statusBar.presence.offlineGroup')}
            </div>
          )}
          {away.map((p) => <PresencePerson key={p.id} p={p} />)}
        </>
      )}
    </div>
  );
}

/**
 * A PERSON IN A PANEL, and the panel is not where the story about them ends.
 *
 * This row used to be a `div`: a face, a name and a dot, and no way to get from
 * any of the three to the person. Every place a person appears has to open
 * their profile, otherwise there are faces the app shows you and refuses to
 * tell you anything about, and the profile page might as well not exist.
 */
export function PresencePerson({ p }: { p: PresenceRow }) {
  return (
    <button
      type="button"
      onClick={() => openPersonProfile(p.id)}
      data-testid="presence-person"
      data-online={p.presente ? 'true' : 'false'}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] hover:bg-app-hover coarse:min-h-11"
      title={p.nome}
    >
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full ${p.presente ? '' : 'opacity-50'}`}>
        {p.avatarUrl
          ? <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[8px] font-semibold leading-none text-app-text">
              {p.iniziali}
            </span>}
      </span>
      <span className={`truncate ${p.presente ? 'text-app-text' : 'text-app-text-muted'}`}>{p.nome}</span>
      <span
        className={`ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full ${p.presente ? PALLINO_OK : 'bg-app-text-muted/40'}`}
      />
    </button>
  );
}

/** The action row at the bottom of a section: the link to the page that governs
 *  what the section shows. The chevron says you are leaving here. */
export function MenuAction({ onClick, children, testId }: {
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} className={POPOVER_ITEM}>
      <span className="truncate">{children}</span>
      <ChevronRight size={12} className="ml-auto flex-shrink-0 text-app-text-muted" />
    </button>
  );
}

/**
 * The faces, overlapped the way a participant list does it.
 *
 * ONLY THE FIRST FEW, then a number. Past the cap they are twelve-pixel discs
 * nobody can tell apart, each as wide as the digit that would count them; the
 * `+N` says the same thing in less room and stays readable.
 */
export function FaceStack({ faces, max = MAX_FACES, total }: {
  faces: PresenceFace[];
  max?: number;
  /** How many are online in total: the `+N` counts the ones with no face too. */
  total?: number;
}) {
  if (faces.length === 0) return null;
  const beyond = (total ?? faces.length) - Math.min(faces.length, max);
  return (
    <span className="flex flex-shrink-0 items-center">
      {faces.slice(0, max).map((f, i) => (
        <span
          key={f.id}
          data-testid="presence-face"
          // The chrome-coloured ring is what keeps two overlapping faces apart:
          // without it, at twelve pixels they read as a single smudge.
          className={`flex h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-full ring-1 ring-app-chrome ${i > 0 ? '-ml-1' : ''}`}
          title={f.nome}
        >
          {f.avatarUrl
            ? <img src={f.avatarUrl} alt="" className="h-full w-full object-cover" />
            : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[7px] font-semibold leading-none text-app-text">
                {f.iniziali}
              </span>}
        </span>
      ))}
      {beyond > 0 && (
        <span data-testid="presence-faces-more" className="ml-0.5 tabular-nums">+{beyond}</span>
      )}
    </span>
  );
}
