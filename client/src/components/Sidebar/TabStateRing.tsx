import { useT } from '../../hooks/useT';
import { usePendingActionStatus, type PendingActionStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { ROW_ACTION_BOX, ROW_ACTION_GLYPH } from '@/lib/selectionStyles';

/**
 * The circle of a row that stands for a tab, for the kinds whose row has no
 * archive of its own (project, terminal, browser, utility page): an open tab
 * closes, a closed row is archived. Both run the 3 s countdown of the strip,
 * under the keys `close-tab:<pane>` and `forget-closed:<pane>`.
 */
export function TabStateRing({ paneId, name, onCloseTab, onForgetClosed, status: given }: {
  paneId: string;
  name: string;
  onCloseTab?: () => void;
  onForgetClosed?: () => void;
  /** The countdown, when the caller already reads it (TabStateRail). */
  status?: PendingActionStatus | null;
}) {
  const tr = useT();
  const own = usePendingActionStatus(given === undefined ? tabStateKey(paneId, !!onCloseTab) : null);
  const status = given === undefined ? own : given;
  const label = onCloseTab ? tr('sidebar.closeTab') : tr('sidebar.archiveRow');
  return (
    <PendingActionRing
      status={status}
      size={ROW_ACTION_GLYPH}
      boxClassName={ROW_ACTION_BOX}
      onIdleClick={onCloseTab ?? onForgetClosed}
      idleTitle={label}
      idleAriaLabel={`${label} ${name}`}
      pendingTitle={tr('sidebar.undoPending')}
      pendingAriaLabel={`${tr('sidebar.undoPending')} ${name}`}
      testId={onCloseTab ? 'row-close-tab' : 'row-archive-closed'}
    />
  );
}

/** The key the circle counts down under: closing an open tab, archiving a closed row. */
// eslint-disable-next-line react-refresh/only-export-components -- the key belongs with the circle that counts under it
export function tabStateKey(paneId: string, open: boolean): string {
  return open ? `close-tab:${paneId}` : `forget-closed:${paneId}`;
}

/**
 * The circle in its rail, as a chat row has it: lit while it counts down
 * (`data-pending` keeps the rail on screen when the pointer leaves, so the
 * cancel stays where it was pressed) and the row's left-to-right fill under it.
 * Archiving a closed terminal, browser or page showed only the circle turning
 * into a check (26/11: "when I archive a tab there is still no animation
 * at all"). Render it as a direct child of the row's card: the fill
 * is absolute, and the card is what it fills.
 */
export function TabStateRail({ className, ...ring }: {
  className: string;
  paneId: string;
  name: string;
  onCloseTab?: () => void;
  onForgetClosed?: () => void;
}) {
  const status = usePendingActionStatus(tabStateKey(ring.paneId, !!ring.onCloseTab));
  return (
    <>
      {status && <PendingActionProgressOverlay status={status} />}
      <span className={className} data-pending={status ? 'true' : undefined}>
        <TabStateRing {...ring} status={status} />
      </span>
    </>
  );
}
