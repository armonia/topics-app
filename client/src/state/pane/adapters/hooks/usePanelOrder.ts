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

/**
 * `pinned` si legge dalle PANE, non da una lista a parte.
 *
 * Qui tornava `pinned: []` sempre — su ogni dispositivo, a ogni mount. Chi lo
 * consuma (`usePaneOrdering`) usa quell'insieme per decidere quale tab è
 * l'ANTEPRIMA, cioè quella che la prossima apertura singola SOSTITUISCE. Con
 * l'insieme vuoto ogni tab è un'anteprima, quindi l'invariante «al massimo una
 * anteprima» degenera e la prima tab della lista diventa rimpiazzabile.
 *
 * Non è un dettaglio di rendering: sostituire una tab la CHIUDE, e nel modello
 * a due stati chiudere una chat significa ARCHIVIARLA — e l'archiviazione è
 * sincronizzata su tutti i dispositivi. Cioè: aprire una chat ne archiviava
 * un'altra, per tutti. Si vedeva soprattutto su un profilo con `localStorage`
 * vuoto (un secondo device, o dopo una pulizia) perché lì non c'è nient'altro
 * che possa fissare le tab dopo il mount.
 *
 * La verità sullo stato di anteprima è già sulla pane (`preview`), è già nella
 * whitelist di `sanitizeSnapshot` e quindi sopravvive al giro dal server. Una
 * pane senza `preview === true` è permanente: qualcuno l'ha aperta per restarci.
 *
 * Il default è deliberatamente il lato SICURO: nel dubbio una tab è fissata. Il
 * caso peggiore diventa «resta aperta una tab in più» invece di «si archivia
 * una conversazione».
 */
export function loadPanelOrder(): PanelOrderState {
  const s = usePaneStore.getState();
  const defaultGroup = s.groups['group:default'];
  const order = defaultGroup?.paneIds ?? [];
  return {
    order,
    pinned: order.filter((id) => s.panes[id]?.preview !== true),
  };
}
