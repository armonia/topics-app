/**
 * Synchronous init-time snapshot of the default group's pane order.
 *
 * Previously this file hosted a full adapter surface (`usePanelOrder`,
 * `usePanelOrderPersistence`, `setPinned`) to preserve the legacy API during
 * the Phase-30 cutover. After the cutover:
 *   - `usePanelOrder` had no consumers — deleted.
 *   - `usePanelOrderPersistence` was a typed no-op (middleware owns
 *     persistence) — deleted.
 *   - `setPinned` was a silent no-op — deleted.
 * Only `loadPanelOrder` remains, used by StandaloneChatGroup at mount to
 * seed its local tab-order `useState`. It is a pure read from the store.
 */
import { usePaneStore } from '../../store';

export interface PanelOrderState {
  order: string[];
  pinned: string[];
}

export function loadPanelOrder(): PanelOrderState {
  const s = usePaneStore.getState();
  const defaultGroup = s.groups['group:default'];
  return {
    order: defaultGroup?.paneIds ?? [],
    pinned: [],
  };
}
