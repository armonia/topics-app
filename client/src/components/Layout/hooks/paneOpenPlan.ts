/**
 * `planOpenPane` — dove va a finire una pane che si apre, deciso senza toccare
 * lo stato.
 *
 * Possiede:
 *  - Le tre uscite possibili di un'apertura: mettere a fuoco quella che c'è già
 *    (`focus`), sostituire l'anteprima del gruppo bersaglio (`replace-preview`),
 *    accodarsi (`append`).
 *  - La scelta del gruppo bersaglio: gruppo a fuoco, altrimenti il primo.
 *  - Il caso «nessun gruppo»: la pane si aggiunge e basta, il gruppo glielo
 *    darà l'orphan-sync (`groupId: null`).
 *
 * NON possiede:
 *  - La costruzione della pane (`newPane` arriva già fatta) né la scrittura di
 *    stato: le tre `setPanes`/`setGroups`/`setFocusedGroupId` restano in
 *    `useProjectFileOpen`.
 *
 * Perché esiste: `handleOpenFile`, `handleOpenDiff` e `handleOpenProcessLog`
 * erano tre copie della stessa quarantina di righe con una differenza sola —
 * se sostituire o no l'anteprima. Tre copie di una regola sono due occasioni di
 * correggerla a metà.
 */
import type { Pane, PaneGroup } from '../../../types';
import { findPreviewPane, replacePaneInGroup } from '../../../lib/previewTabs';

export type OpenPanePlan =
  /** Esiste già: la si attiva nel suo gruppo. `groupId` è `null` se la pane
   *  esiste ma è orfana — allora non c'è niente da attivare. */
  | { kind: 'focus'; paneId: string; groupId: string | null }
  /** Nuova pane in coda al gruppo bersaglio (`null` = nessun gruppo ancora). */
  | { kind: 'append'; pane: Pane; groupId: string | null }
  /** Nuova pane al POSTO dell'anteprima già presente nel gruppo bersaglio. */
  | { kind: 'replace-preview'; pane: Pane; groupId: string; replacedPaneId: string; paneIds: string[] };

export function planOpenPane(
  panes: Pane[],
  groups: PaneGroup[],
  focusedGroupId: string | null,
  newPane: Pane,
  opts: {
    /** Come si riconosce che la pane richiesta è già aperta. */
    matchExisting: (p: Pane) => boolean;
    /** Se true, una pane di anteprima dello stesso tipo nel gruppo bersaglio
     *  viene sostituita invece che affiancata (file e diff sì, log di processo
     *  no — quello non è mai un'anteprima). */
    replacePreviewOfType?: Pane['type'];
  },
): OpenPanePlan {
  const existing = panes.find(opts.matchExisting);
  if (existing) {
    const g = groups.find(gr => gr.paneIds.includes(existing.id));
    return { kind: 'focus', paneId: existing.id, groupId: g?.id ?? null };
  }

  const targetGroup = (focusedGroupId ? groups.find(g => g.id === focusedGroupId) : null) || groups[0];
  if (!targetGroup) return { kind: 'append', pane: newPane, groupId: null };

  if (opts.replacePreviewOfType) {
    const groupPanes = targetGroup.paneIds
      .map(id => panes.find(p => p.id === id))
      .filter((p): p is Pane => !!p && p.type === opts.replacePreviewOfType);
    const existingPreview = findPreviewPane(groupPanes, newPane.id);
    if (existingPreview) {
      return {
        kind: 'replace-preview',
        pane: newPane,
        groupId: targetGroup.id,
        replacedPaneId: existingPreview.id,
        paneIds: replacePaneInGroup(targetGroup.paneIds, existingPreview.id, newPane.id),
      };
    }
  }

  return { kind: 'append', pane: newPane, groupId: targetGroup.id };
}
