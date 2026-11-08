/**
 * THE TWO ROWS BETWEEN THE USER SHEET LEVELS (mobile-chrome-feedback A1).
 *
 * On the phone the sheet has two levels: the root, who you are (identity) and
 * how things stand (system, version), and the Topics level, with the rows of
 * `TopicsMenuItems`. Between them sit these two rows, and only them: the
 * "Topics" entry goes down to the level, "Back" climbs to the root.
 *
 * WHY TWO LEVELS AND NOT THE FLAT LIST. The flat sheet mixed twelve rows from
 * three different owners (identity, topics, system): the Topics menu had no
 * door, it was a stretch of road between stretches of other roads. Behind an
 * entry lies a place you reach, and the root stays the user menu, who you are
 * and how the machine is doing, one tap from opening.
 *
 * It lives in its own file, and not as two rows in App, because "Back" is a
 * word that gets read: App does not import `useT` (the second pass of
 * check-ui-language would light up the whole file) so these two rows take
 * their `tr` here.
 */
import { ChevronLeft, ChevronRight, ListTree } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { menuRowClass } from './menuRow';

/** The "Topics" entry at the sheet root: it goes down to the topics level. */
export function TopicsEntryRow({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="user-menu-topics-entry"
      className={menuRowClass(true)}
      // "Topics" is a proper name, the same in both languages: the other rows
      // of the sheet already spell it this way (the column header).
      title="Topics"
      aria-label="Topics"
    >
      <ListTree size={18} className="flex-shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">Topics</span>
      <ChevronRight size={18} className="flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
    </button>
  );
}

/** The first row of the Topics level: it climbs back to the sheet root. */
export function TopicsBackRow({ onBack }: { onBack: () => void }) {
  const tr = useT();
  return (
    <button
      type="button"
      onClick={onBack}
      data-testid="user-menu-topics-back"
      className={menuRowClass(true)}
      title={tr('sidebar.userMenuBack')}
      aria-label={tr('sidebar.userMenuBack')}
    >
      <ChevronLeft size={18} className="flex-shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">{tr('sidebar.userMenuBack')}</span>
    </button>
  );
}
