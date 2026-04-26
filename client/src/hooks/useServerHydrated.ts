import { useSyncExternalStore } from 'react';
import { hasReceivedServerHydrate, onServerHydrated } from '../state/pane/middleware/serverHydrated';

/**
 * React hook returning `true` once this tab has received an authoritative
 * server hydrate (WS `ui-state:init` / `ui-state:updated` or the boot GET
 * fallback). Used to gate device-local state syncs that would otherwise
 * race the async hydrate and clobber persisted layout — see
 * `usePanelGridPersistence` and the `naturalGridItems` sync in `PanelGrid`.
 *
 * One-shot: once true, stays true for the rest of the session.
 */
export function useServerHydrated(): boolean {
  return useSyncExternalStore(
    (onChange) => onServerHydrated(onChange),
    hasReceivedServerHydrate,
    () => false, // SSR fallback (we don't SSR but useSyncExternalStore requires it)
  );
}
