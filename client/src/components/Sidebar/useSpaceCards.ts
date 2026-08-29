/**
 * Cosa sa la sidebar dei GRUPPI: le card da disegnare, e come ci si va.
 *
 * Vive accanto a `SpaceGroups.tsx` ma in un file suo, e la ragione è meccanica:
 * un modulo che esporta SIA componenti SIA hook spegne il fast refresh di Vite
 * — al salvataggio ricarica la pagina invece di sostituire il componente in
 * posto, e con la pagina se ne va lo stato che stavi guardando. La regola è
 * `react-refresh/only-export-components`, ed è un ERRORE in CI, non un
 * consiglio.
 *
 * Il confine cade dove cadeva già da sé: qui il MODELLO (quali gruppi, quante
 * tab, che segnale, dove vivono), là la resa.
 */
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, type SpaceMeta, type Pane } from '../../state/pane/types';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { useSignalsStore, projectAttentionTier } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { useSpaceWindows } from '../../state/windowPresence';
import { focusSpaceWindow, claimSpaceLocally } from '../../lib/popOutSpace';
import { DEFAULT_SPACE_LABEL, liveSpacesOrdered } from '../Layout/spaceHelpers';
import { repinSpaceWindow, spaceWindowId } from '../../lib/windowRole';
import type { AttentionTier, Topic, TerminalSessionInfo } from '../../types';

interface AttentionSets {
  awaitingInputTopics: Set<string>;
  awaitingFeedbackTopics: Set<string>;
  claudePhaseAwaitingInputTermIds: Set<string>;
  claudePhaseAwaitingTermIds: Set<string>;
  terminalFinishedIds: Set<string>;
  seenSubjects: ReadonlySet<string>;
}

/**
 * Il tier di attenzione di un gruppo: il più forte fra i suoi pane ('input'
 * batte 'done'), o null. Costruito sugli STESSI insiemi per-soggetto che
 * leggono la barra delle tab e le righe della sidebar — parità di badge,
 * nessuna matematica privata di questo componente. Serve soprattutto quando la
 * card è chiusa: è l'unica cosa che dice "là dentro ti aspettano".
 *
 * A read chat no longer feeds the 'done' branch: `seenSubjects` gates it, the
 * same fix the PROJECT tab already got in `projectAttentionTier`. Without it the
 * card kept its blue dot after you read the chat, because a Claude phase like
 * `awaiting-user` does not clear by itself — it stays until the next turn, so
 * the row and the tab went quiet while the group header stayed lit.
 *
 * The 'input' branch is deliberately NOT gated. `awaitingInputTopics` also
 * carries `askWaitingTopics`, which never goes through `applyNewAttention`: a
 * seen mark on a pending question would never be cleared, and the card would go
 * mute for good on a request that is still waiting for an answer.
 *
 * Exported for the unit test: the hook around it needs a React store, the rule
 * does not.
 */
export function spaceAttentionTier(
  spaceId: string,
  panes: Record<string, Pane>,
  spaces: Record<string, SpaceMeta>,
  sig: AttentionSets,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
): AttentionTier | null {
  let hasDone = false;
  for (const pane of Object.values(panes)) {
    if (resolvePaneSpace(pane, spaces) !== spaceId) continue;
    if (pane.type === 'chat') {
      const topicId = pane.topicId ?? pane.id;
      if (sig.awaitingInputTopics.has(topicId)) return 'input';
      if (sig.seenSubjects.has(topicId)) continue;
      if (sig.awaitingFeedbackTopics.has(topicId)) hasDone = true;
    } else if (pane.type === 'terminal') {
      const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id);
      if (!sid) continue;
      // NB: qui NON si filtra per "visto" — vedi la nota gemella in signals.ts:
      // `terminalFinishedIds` copre le sessioni SENZA fase nota, e il reset del
      // visto passa da `claudePhaseAwaitingTermIds`. Le due popolazioni sono
      // disgiunte, quindi un gate qui renderebbe muto per sempre il pallino di
      // una sessione hook-less al secondo turno finito.
      if (sig.claudePhaseAwaitingInputTermIds.has(sid)) return 'input';
      if (sig.claudePhaseAwaitingTermIds.has(sid) || sig.terminalFinishedIds.has(sid)) hasDone = true;
    } else if (pane.type === 'project' && pane.projectPath) {
      const tier = projectAttentionTier(
        pane.projectPath,
        topics,
        terminalSessions,
        sig.awaitingFeedbackTopics,
        sig.claudePhaseAwaitingTermIds,
        sig.awaitingInputTopics,
        sig.claudePhaseAwaitingInputTermIds,
        sig.seenSubjects,
      );
      if (tier === 'input') return 'input';
      if (tier === 'done') hasDone = true;
    }
  }
  return hasDone ? 'done' : null;
}

/** Separatore dello snapshot: un carattere di controllo che nessun titolo
 *  contiene, così encode/decode è totale. */
const SEP = '\u0001';

/** Una card della sidebar: un gruppo, con quello che serve per disegnarlo. */
export interface SpaceCard {
  id: string;
  name: string;
  /** È il gruppo che vive nella griglia (`activeSpaceId`). */
  active: boolean;
  /** Quante tab tiene. */
  count: number;
  /** Il più forte segnale dei suoi pane, o null. */
  tier: AttentionTier | null;
  /** L'etichetta della finestra in cui vive, se è stato staccato. */
  detachedLabel?: string;
}

/**
 * Le card da disegnare, in ordine, con tutto ciò che serve: una sola serie di
 * iscrizioni allo store per tutte le card, invece di una per card.
 *
 * Il gruppo principale c'è sempre ed è il primo — è implicito nella registry
 * (nessun record), ma nella sidebar è una card come le altre.
 */
export function useSpaceCards(): SpaceCard[] {
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const spaces = usePaneStore((s) => s.spaces);
  const panes = usePaneStore((s) => s.panes);
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const spaceWindows = useSpaceWindows();
  const sig = useSignalsStore(
    useShallow((s) => ({
      awaitingInputTopics: s.awaitingInputTopics,
      awaitingFeedbackTopics: s.awaitingFeedbackTopics,
      claudePhaseAwaitingInputTermIds: s.claudePhaseAwaitingInputTermIds,
      claudePhaseAwaitingTermIds: s.claudePhaseAwaitingTermIds,
      terminalFinishedIds: s.terminalFinishedIds,
      seenSubjects: s.seenSubjects,
    })),
  );

  // Quante tab tiene ciascun gruppo. Codificato come STRINGHE piatte e
  // decodificato sotto: iscriversi a `s.panes` qui ridisegnerebbe le card a
  // ogni scrittura di pane — `setPaneScrollOffset` ne fa una ogni 250 ms
  // mentre scorri una chat — perché Immer restituisce un'identità nuova ogni
  // volta.
  const encodedSpaces = usePaneStore(
    useShallow((s) => (s.groups['group:default']?.paneIds ?? []).map(
      (id) => resolvePaneSpace(s.panes[id], s.spaces) + SEP,
    )),
  );
  const countBySpace = useMemo(() => {
    const m = new Map<string, number>();
    for (const enc of encodedSpaces) {
      const spaceId = enc.slice(0, -1);
      m.set(spaceId, (m.get(spaceId) ?? 0) + 1);
    }
    return m;
  }, [encodedSpaces]);

  const pinnedSpace = spaceWindowId();
  const ordered = useMemo(() => liveSpacesOrdered(spaces), [spaces]);

  return useMemo(() => {
    const rows: { id: string; name: string }[] = [
      { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
      ...ordered.map((s) => ({ id: s.id, name: s.name || 'Gruppo' })),
    ];
    // TUTTI i gruppi, in OGNI finestra — anche in una finestra-gruppo. Prima
    // lì se ne vedeva uno solo: una finestra che non sa dire cosa c'è nelle
    // altre è cieca, e per passare da un gruppo all'altro toccava tornare alla
    // principale. Cliccare un altro gruppo porta davanti la sua finestra se ce
    // l'ha, altrimenti se lo prende questa (vedi `useGoToSpace`).
    void pinnedSpace;
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        active: r.id === activeSpaceId,
        count: countBySpace.get(r.id) ?? 0,
        tier: spaceAttentionTier(r.id, panes, spaces, sig, topics, terminalSessions),
        detachedLabel: spaceWindows.get(r.id),
      }))
      // UN GRUPPO SI DISEGNA FINCHÉ TIENE QUALCOSA. A zero tab la card diceva
      // «Nessuna tab» e restava lì finché non la scioglievi a mano: una scatola
      // vuota, cioè il modo più veloce di rendere illeggibile una colonna che
      // senza gruppi si leggeva bene.
      //
      // Due eccezioni. Il PRINCIPALE resta sempre: è la casa delle tab che non
      // stanno in nessun gruppo ed è il bersaglio su cui si lascia cadere una
      // tab per tirarla FUORI da un gruppo — senza, il gesto non avrebbe dove
      // atterrare. E un gruppo che vive in una finestra sua resta anche a zero:
      // è da qui che lo si porta davanti o lo si richiama indietro.
      .filter((c) => c.id === DEFAULT_SPACE_ID || c.count > 0 || !!c.detachedLabel);
  }, [ordered, pinnedSpace, activeSpaceId, countBySpace, panes, spaces, sig, topics, terminalSessions, spaceWindows]);
}

/** Porta la finestra sul gruppo `spaceId` — o, se quel gruppo vive in una
 *  finestra sua, porta davanti quella. */
export function useGoToSpace(): (spaceId: string) => void {
  const dispatch = usePaneStore((s) => s.dispatch);
  const spaceWindows = useSpaceWindows();
  return useCallback((spaceId: string) => {
    // Questa finestra si sposta sul gruppo: in una finestra-GRUPPO significa
    // ri-inchiodarla (la query È la sua identità, un SET_ACTIVE_SPACE da solo
    // verrebbe disfatto al primo hydrate).
    const take = () => {
      // Rivendicazione esplicita: da qui in poi l'automatismo che rimanda i
      // gruppi alla loro finestra lascia stare QUESTO gruppo in QUESTA finestra.
      claimSpaceLocally(spaceId);
      if (spaceWindowId()) repinSpaceWindow(spaceId);
      if (spaceId !== usePaneStore.getState().activeSpaceId) {
        dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: spaceId } });
      }
    };
    const label = spaceWindows.get(spaceId);
    if (label) {
      void focusSpaceWindow(label).then((focused) => {
        // Se quella finestra non c'è più (chiusa, altra macchina) si ricade sul
        // mostrarlo qui: meglio un gruppo che si apre di un clic che non fa niente.
        if (!focused) take();
      });
      return;
    }
    take();
  }, [dispatch, spaceWindows]);
}
