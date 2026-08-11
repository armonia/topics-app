/**
 * `reconcileGroupsWithPanes` — the orphan-sync pass, as a pure function.
 *
 * Possiede:
 *  - La regola completa «i gruppi seguono le pane»: potare gli id di pane
 *    morti, far sparire i gruppi rimasti vuoti, e ricollocare le pane ORFANE
 *    (esistono in `panes` ma nessun gruppo le elenca) per affinità di tipo.
 *  - La scelta del gruppo bersaglio per gli orfani: gruppo a fuoco dello stesso
 *    tipo → primo gruppo di quel tipo → gruppo a fuoco → primo gruppo → gruppo
 *    nuovo.
 *  - La sostituzione dell'anteprima: un orfano `preview` prende il posto della
 *    pane di anteprima già presente nel bersaglio invece di affiancarla.
 *
 * NON possiede:
 *  - Righe, larghezze, altezze (`rowLayoutReconcile`).
 *  - Il fuoco (`focusedGroupId` entra come input, non viene mai riscritto).
 *  - La chiusura della chat di anteprima sostituita: la si SEGNALA con
 *    `previewCloseTopicId`, la esegue l'effetto che drena
 *    `pendingPreviewCloseRef` in `useProjectLayout`.
 *
 * Era il corpo di un `setGroups(prev => …)` di 115 righe dentro
 * `useProjectLayout`: nessun test poteva toccarlo senza montare un albero
 * React. Qui è una funzione con quattro ingressi e un valore di ritorno.
 */
import type { Pane, PaneGroup, PaneGroupType } from '../../../types';
import { findPreviewPane, replacePaneInGroup } from '../../../lib/previewTabs';
import { createGroupId } from '../../../state/pane/adapters/paneConfig';
import { paneTypeToGroupType } from './groupOps';

export interface GroupPaneReconciliation {
  /** I gruppi riconciliati — `prev` PER IDENTITÀ quando non c'è nulla da fare,
   *  così `setGroups` non rirenderizza per niente. */
  groups: PaneGroup[];
  /** topicId della chat di anteprima appena sostituita, da chiudere fuori di
   *  qui; `null` quando non c'è stata sostituzione. */
  previewCloseTopicId: string | null;
}

export function reconcileGroupsWithPanes(
  prev: PaneGroup[],
  panes: Pane[],
  focusedGroupId: string | null,
  /** Pane che `reopenChatPane` sta per collocare in un gruppo esplicito:
   *  lasciarla orfana per un tick impedisce all'affinità di tipo di rubarla. */
  targetedChatPaneId?: string,
): GroupPaneReconciliation {
  const allPaneIds = new Set(panes.map(p => p.id));
  let anyGroupChanged = false;
  let updated = prev.map(g => {
    const filtered = g.paneIds.filter(id => allPaneIds.has(id));
    if (filtered.length === g.paneIds.length) return g;
    anyGroupChanged = true;
    const activePaneId = filtered.includes(g.activePaneId)
      ? g.activePaneId
      : filtered[0] || g.activePaneId;
    return { ...g, paneIds: filtered, activePaneId };
  });
  const beforeFilterLen = updated.length;
  updated = updated.filter(g => g.paneIds.length > 0);
  if (updated.length !== beforeFilterLen) anyGroupChanged = true;

  const paneToGroupIdx = new Map<string, number>();
  for (let i = 0; i < updated.length; i++) {
    for (const pid of updated[i].paneIds) {
      paneToGroupIdx.set(pid, i);
    }
  }

  const orphanPanes = panes.filter(
    p => !paneToGroupIdx.has(p.id) && p.id !== targetedChatPaneId,
  );

  if (!anyGroupChanged && orphanPanes.length === 0) {
    return { groups: prev, previewCloseTopicId: null };
  }

  const orphansByType = new Map<PaneGroupType, Pane[]>();
  for (const p of orphanPanes) {
    const gt = paneTypeToGroupType(p.type);
    if (!orphansByType.has(gt)) orphansByType.set(gt, []);
    orphansByType.get(gt)!.push(p);
  }

  const groupIdToIdx = new Map<string, number>();
  for (let i = 0; i < updated.length; i++) {
    groupIdToIdx.set(updated[i].id, i);
  }
  const groupTypeToFirstIdx = new Map<PaneGroupType, number>();
  for (let i = 0; i < updated.length; i++) {
    if (!groupTypeToFirstIdx.has(updated[i].type)) {
      groupTypeToFirstIdx.set(updated[i].type, i);
    }
  }

  const focusedIdx = focusedGroupId ? groupIdToIdx.get(focusedGroupId) : undefined;
  const focusedGroup = focusedIdx !== undefined ? updated[focusedIdx] : null;

  let previewCloseTopicId: string | null = null;

  for (const [gt, orphans] of orphansByType) {
    let targetIdx: number | undefined;
    if (focusedGroup?.type === gt) {
      targetIdx = focusedIdx;
    }
    if (targetIdx === undefined) {
      targetIdx = groupTypeToFirstIdx.get(gt);
    }
    if (targetIdx === undefined && focusedIdx !== undefined) {
      targetIdx = focusedIdx;
    }
    if (targetIdx === undefined && updated.length > 0) {
      targetIdx = 0;
    }

    if (targetIdx !== undefined) {
      const tIdx = targetIdx;
      const previewOrphan = orphans.find(o => o.preview);
      if (previewOrphan) {
        const targetGroup = updated[tIdx];
        const existingPreview = findPreviewPane(
          targetGroup.paneIds
            .map(id => panes.find(p => p.id === id))
            .filter((p): p is Pane => !!p && paneTypeToGroupType(p.type) === gt),
          previewOrphan.id,
        );
        if (existingPreview) {
          const newPaneIds = replacePaneInGroup(targetGroup.paneIds, existingPreview.id, previewOrphan.id);
          const otherOrphans = orphans.filter(o => o !== previewOrphan);
          updated = updated.map((g, i) =>
            i === tIdx
              ? {
                  ...g,
                  paneIds: otherOrphans.length > 0 ? [...newPaneIds, ...otherOrphans.map(p => p.id)] : newPaneIds,
                  activePaneId: previewOrphan.id,
                }
              : g,
          );
          if (gt === 'chat' && existingPreview.topicId) {
            previewCloseTopicId = existingPreview.topicId;
          }
          continue;
        }
      }
      updated = updated.map((g, i) =>
        i === tIdx ? { ...g, paneIds: [...g.paneIds, ...orphans.map(p => p.id)] } : g,
      );
    } else {
      const newGroup: PaneGroup = {
        id: createGroupId(),
        paneIds: orphans.map(p => p.id),
        activePaneId: orphans[0].id,
        type: gt,
      };
      updated = [...updated, newGroup];
    }
  }

  return { groups: updated, previewCloseTopicId };
}
