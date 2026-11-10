/**
 * Chi può aprire una tab nella barra di Attilio, e come.
 *
 * Due regole, chieste il 10/11: aprire una chat riusa la tab di anteprima
 * (la sostituisce) e la tab resta solo quando lui ci interagisce; le chat
 * nate da un agente non aprono tab, stanno nella loro sezione (barra laterale,
 * Agenti, board) e da lì si raggiungono.
 *
 * Il 10/11 la finestra di progetto di Jarvis aveva 47 tab: 40 erano chat dei
 * canali e dei lavori programmati che nessuno aveva aperto, entrate da sole
 * dal ramo «delta-add» di useProjectChatSync.
 */
import type { Pane, PaneGroup, Topic } from '../types';
import { findPreviewPane, replacePaneInGroup } from './previewTabs';

/**
 * Una chat che non ha aperto Attilio: un sottoagente (`subagentOf`), una
 * conversazione aperta da Jarvis sotto una delle sue radici (`parentId`:
 * «Jarvis, canali», «Jarvis, lavori programmati»), una sessione di card
 * dispatchata (`mcpPolicy: 'bridge-only'`, la mette solo il dispatcher).
 */
export function isAgentOwnedTopic(topic: Pick<Topic, 'subagentOf' | 'parentId' | 'mcpPolicy'> | null | undefined): boolean {
  if (!topic) return false;
  return !!topic.subagentOf || !!topic.parentId || topic.mcpPolicy === 'bridge-only';
}

export type ChatTabPlan =
  | { kind: 'replace-preview'; replacedPaneId: string; paneIds: string[] }
  | { kind: 'append'; paneIds: string[] };

/**
 * Dove va una chat aperta in anteprima dentro un gruppo: al posto della chat
 * di anteprima che c'è già (una sola tab provvisoria per gruppo), altrimenti
 * in coda. Le tab fissate non si toccano mai.
 */
export function planPreviewChatTab(group: PaneGroup, panes: Pane[], newPaneId: string): ChatTabPlan {
  const groupChats = group.paneIds
    .map(id => panes.find(p => p.id === id))
    .filter((p): p is Pane => !!p && p.type === 'chat');
  const preview = findPreviewPane(groupChats, newPaneId);
  if (preview) {
    return {
      kind: 'replace-preview',
      replacedPaneId: preview.id,
      paneIds: replacePaneInGroup(group.paneIds, preview.id, newPaneId),
    };
  }
  return {
    kind: 'append',
    paneIds: group.paneIds.includes(newPaneId) ? group.paneIds : [...group.paneIds, newPaneId],
  };
}

const PARKED_KEY = 'topics-agent-tabs-parked-v1:';

/**
 * Migrazione una tantum: le tab di chat di agenti già aperte in una finestra
 * si chiudono la prima volta che la finestra carica con questa regola. Non si
 * perde niente: la chat resta viva e nella sua sezione. Dopo, una chat di
 * agente aperta da Attilio e fissata resta, perché il marcatore c'è già.
 */
export function shouldParkAgentTabs(projectPath: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return !storage || storage.getItem(PARKED_KEY + projectPath) !== '1'; } catch { return false; }
}

export function markAgentTabsParked(projectPath: string, storage: Pick<Storage, 'setItem'> | null): void {
  try { storage?.setItem(PARKED_KEY + projectPath, '1'); } catch { /* storage pieno o negato: si riprova al prossimo carico */ }
}
