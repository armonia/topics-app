import { useT } from '../../hooks/useT';
import { usePendingActionStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { ROW_ACTION_BOX, ROW_ACTION_GLYPH } from '@/lib/selectionStyles';

/**
 * The circle of a row that stands for a tab, for the kinds whose row has no
 * archive of its own (project, terminal, browser, utility page): an open tab
 * closes, a closed row is archived. Both run the 3 s countdown of the strip,
 * under the keys `close-tab:<pane>` and `forget-closed:<pane>`.
 */
export function TabStateRing({ paneId, name, onCloseTab, onForgetClosed }: {
  paneId: string;
  name: string;
  onCloseTab?: () => void;
  onForgetClosed?: () => void;
}) {
  const tr = useT();
  const status = usePendingActionStatus(onCloseTab ? `close-tab:${paneId}` : `forget-closed:${paneId}`);
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
