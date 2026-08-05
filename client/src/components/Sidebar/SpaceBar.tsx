/**
 * SpaceBar — i GRUPPI, in fondo alla sidebar (grammatica Arc/Dia).
 *
 * Un gruppo è l'unità: un insieme di tab che vivi insieme. Prima abitava in due
 * posti che si contraddicevano — una striscia di chip SOPRA la griglia (a
 * destra, lontano dalle tab che governava) e una sezione "Gruppi" nella sidebar
 * che ri-elencava le stesse tab con un albero tutto suo. Due copie della stessa
 * cosa: chi ne guardava una non sapeva dell'altra, e nessuna delle due diceva a
 * quale gruppo appartenesse la tab che stavi guardando.
 *
 * Ora ce n'è una sola, e sta dove stanno le tab: la sidebar È il gruppo attivo
 * (la sua lista mostra solo le tab di quel gruppo — `visiblePanels`), il suo
 * NOME sta in cima (`SpaceTitle`), e qui sotto ci sono gli altri gruppi con il
 * "+" per aggiungerne. Nessun albero: le tab sono già elencate sopra.
 *
 * Un gruppo può essere STACCATO in una finestra sua (`window_detach_space`).
 * Allora il suo chip porta il glifo della finestra e il click non commuta:
 * porta in primo piano quella finestra. È l'unica cosa che la vecchia sezione
 * "Finestre" sapeva fare, detta dove ha senso — sul gruppo, non su una lista
 * parallela.
 */
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, Pencil, Plus, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDismissable } from '../../hooks/useDismissable';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX, type SpaceMeta, type Pane } from '../../state/pane/types';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { useSignalsStore, projectAttentionTier } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { useSpaceWindows } from '../../state/windowPresence';
import { focusSpaceWindow, popOutSpace } from '../../lib/popOutSpace';
import { SELECTED_SURFACE, RESTING_SURFACE, ROW_INSET, TIER_DONE_BG, TIER_INPUT_BG } from '../../lib/selectionStyles';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_MARGIN, POPOVER_ITEM_DANGER, POPOVER_DIVIDER, Z_POPOVER } from '../../lib/popoverStyles';
import { clearPanelGridStorage } from '../Layout/usePanelGridPersistence';
import {
  DEFAULT_SPACE_LABEL,
  liveSpacesOrdered,
  createSpaceId,
  nextSpaceName,
  isDetachedWindow,
} from '../Layout/spaceHelpers';
import { spaceWindowId } from '../../lib/windowRole';
import { useMobile } from '../../hooks/useMobile';
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
 * leggono la barra delle tab e la sidebar — parità di badge, nessuna
 * matematica privata di questa barra.
 */
function spaceAttentionTier(
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
      if (sig.awaitingFeedbackTopics.has(topicId)) hasDone = true;
    } else if (pane.type === 'terminal') {
      const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id);
      if (!sid) continue;
      // NB: qui NON si filtra per "visto" — vedi la nota gemella in signals.ts:
      // `terminalFinishedIds` copre le sessioni SENZA fase nota, e il reset del
      // visto passa da `claudePhaseAwaitingTermIds`. Le due popolazioni sono
      // disgiunte, quindi un gate qui renderebbe muto per sempre il chip di una
      // sessione hook-less al secondo turno finito.
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

/** Larghezza minima del menu — così il clamp orizzontale non deve misurare
 *  (tienila in lockstep con il min-w qui sotto). */
const MENU_MIN_W = 190;

interface ChipMenuState {
  spaceId: string;
  x: number;
  y: number;
}

export function SpaceBar() {
  const dispatch = usePaneStore((s) => s.dispatch);
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const spaces = usePaneStore((s) => s.spaces);
  const panes = usePaneStore((s) => s.panes);
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const detachedSpaces = useSpaceWindows();
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

  // `useMobile()` rende un OGGETTO: destrutturare non è un vezzo — prenderlo
  // intero lo rende sempre truthy, e l'hover-reveal qui sotto sparirebbe
  // (misurato: opacity 1 anche senza hover).
  const { isMobile, isTouch } = useMobile();
  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismissable({
    open: chipMenu !== null,
    onClose: () => setChipMenu(null),
    refs: [menuRef],
  });

  const ordered = useMemo(() => liveSpacesOrdered(spaces), [spaces]);

  // In una finestra di gruppo (o in una vecchia pop-out `?topics=`) non si
  // commuta niente: quella finestra È un gruppo, e mostrarne l'elenco
  // inviterebbe a spostarsi altrove dentro una finestra che non lo sa fare.
  if (isDetachedWindow() || spaceWindowId()) return null;

  const addSpace = () => {
    const id = createSpaceId();
    dispatch({ type: 'SPACE_UPSERT', payload: { space: { id, name: nextSpaceName(spaces) } } });
    dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id } });
  };

  const canAdd = liveSpaceCount(spaces) < SPACES_MAX;

  // «Nuovo gruppo» si accende sull'hover della sidebar (desktop): è un comando
  // che serve una volta ogni tanto, e tenerlo acceso in fondo a ogni sessione
  // lo trasforma in arredamento. Su mobile non esiste hover — lì resta visibile
  // sempre, o sarebbe irraggiungibile. La messa a fuoco da tastiera lo rivela
  // comunque (`focus-visible`), così non sparisce per chi naviga col Tab.
  const revealOnHover = isMobile || isTouch
    ? ''
    : 'opacity-0 transition-opacity group-hover/sidebar:opacity-100 focus-visible:opacity-100';

  // Nessun gruppo creato: una riga sola con l'invito, che è anche il modo per
  // scoprire che i gruppi esistono. Prima si nascevano solo dal menu
  // contestuale di una tab, cioè da nessuna parte.
  if (ordered.length === 0) {
    return (
      <div
        className="flex items-center border-t border-app-border"
        style={{ paddingLeft: ROW_INSET, paddingRight: ROW_INSET }}
        data-testid="sidebar-space-bar"
      >
        <button
          onClick={addSpace}
          className={`my-1 flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] text-app-text-muted transition-colors hover:bg-app-hover hover:text-app-text ${revealOnHover}`}
          title="Un gruppo è un insieme di tab che vivi insieme, e che puoi staccare in una finestra"
          data-testid="space-add"
        >
          <Plus size={13} />
          <span>Nuovo gruppo</span>
        </button>
      </div>
    );
  }

  const chips: { id: string; name: string }[] = [
    { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
    ...ordered.map((s) => ({ id: s.id, name: s.name || 'Gruppo' })),
  ];

  const menuSpace = chipMenu ? spaces[chipMenu.spaceId] : undefined;
  const menuDetachedLabel = chipMenu ? detachedSpaces.get(chipMenu.spaceId) : undefined;

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-t border-app-border py-1"
      style={{ paddingLeft: ROW_INSET, paddingRight: ROW_INSET }}
      data-testid="sidebar-space-bar"
      role="tablist"
      aria-label="Gruppi"
    >
      {chips.map((chip) => {
        const isActive = chip.id === activeSpaceId;
        const detachedLabel = detachedSpaces.get(chip.id);
        // IL FUOCO VINCE (precedente di sidebarRowCard): il gruppo che stai
        // guardando non porta mai il pallino — ci sei già.
        const tier = isActive ? null : spaceAttentionTier(chip.id, panes, spaces, sig, topics, terminalSessions);
        return (
          <button
            key={chip.id}
            role="tab"
            aria-selected={isActive}
            data-space-id={chip.id}
            data-testid="space-chip"
            onClick={() => {
              // Staccato: il click porta in primo piano la SUA finestra. Se non
              // c'è più (chiusa, altra macchina), si ricade sul commutare qui.
              if (detachedLabel) {
                void focusSpaceWindow(detachedLabel).then((focused) => {
                  if (!focused && !isActive) {
                    dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: chip.id } });
                  }
                });
                return;
              }
              if (!isActive) dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: chip.id } });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setRenameDraft(null);
              setChipMenu({ spaceId: chip.id, x: e.clientX, y: e.clientY });
            }}
            className={`flex h-6 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] whitespace-nowrap transition-colors ${
              isActive && !detachedLabel ? SELECTED_SURFACE : `${RESTING_SURFACE} text-app-text-secondary hover:text-app-text`
            }`}
            title={detachedLabel ? `${chip.name} — in una finestra sua (clic per portarla davanti)` : chip.name}
          >
            <span className="max-w-[120px] truncate">{chip.name}</span>
            {detachedLabel && (
              <AppWindow size={11} className="flex-shrink-0" data-testid="space-detached" aria-label="in una finestra sua" />
            )}
            {tier && (
              <span
                aria-label={tier === 'input' ? 'richiede input' : 'attività completata'}
                className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  tier === 'input' ? `${TIER_INPUT_BG} animate-pulse` : TIER_DONE_BG
                }`}
              />
            )}
          </button>
        );
      })}
      {canAdd && (
        <button
          onClick={addSpace}
          className={`flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md ${RESTING_SURFACE} text-app-text-muted transition-colors hover:text-app-text ${revealOnHover}`}
          title="Nuovo gruppo"
          aria-label="Nuovo gruppo"
          data-testid="space-add"
        >
          <Plus size={13} />
        </button>
      )}

      {chipMenu && createPortal(
        <div
          ref={menuRef}
          // Aperto sulle coordinate del cursore, ma dentro lo schermo: il
          // clamp sui due assi è lo stesso di ogni altro menu (POPOVER_MARGIN).
          className={`fixed ${POPOVER_SURFACE} min-w-[190px] overflow-y-auto overscroll-contain`}
          style={{
            top: Math.max(POPOVER_MARGIN, chipMenu.y - 8),
            left: Math.max(
              POPOVER_MARGIN,
              Math.min(chipMenu.x, window.innerWidth - MENU_MIN_W - POPOVER_MARGIN),
            ),
            maxHeight: `calc(100vh - ${POPOVER_MARGIN * 2}px)`,
            transform: 'translateY(-100%)',
            zIndex: Z_POPOVER,
          }}
          data-testid="space-menu"
        >
          {menuSpace && !menuSpace.deleted && (
            renameDraft !== null ? (
              <form
                className="px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = renameDraft.trim();
                  if (name) {
                    dispatch({ type: 'SPACE_UPSERT', payload: { space: { id: chipMenu.spaceId, name } } });
                  }
                  setChipMenu(null);
                }}
              >
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  className="w-full rounded-md border border-app-border-light bg-app-hover px-2 py-1 text-[12px] text-app-text outline-none focus:border-primary"
                  placeholder="Nome del gruppo"
                  aria-label="Rinomina gruppo"
                />
              </form>
            ) : (
              <button onClick={() => setRenameDraft(menuSpace.name)} className={POPOVER_ITEM}>
                <Pencil size={14} />
                <span className="flex-1">Rinomina</span>
              </button>
            )
          )}
          <button
            onClick={() => {
              const spaceId = chipMenu.spaceId;
              setChipMenu(null);
              if (menuDetachedLabel) {
                void focusSpaceWindow(menuDetachedLabel);
                return;
              }
              void popOutSpace(spaceId);
            }}
            className={POPOVER_ITEM}
            title={menuDetachedLabel
              ? 'È già in una finestra sua: la porto davanti'
              : 'Il gruppo si apre in una finestra sua; le sue tab restano queste'}
            data-testid="space-detach"
          >
            <AppWindow size={14} />
            <span className="flex-1">{menuDetachedLabel ? 'Vai alla sua finestra' : 'Sposta in una finestra'}</span>
          </button>
          {menuSpace && !menuSpace.deleted && (
            <>
              <div className={POPOVER_DIVIDER} />
              <button
                onClick={() => {
                  // Cancellazione morbida: le tab tornano nel gruppo
                  // principale (il reducer fa entrambe le mosse), niente si
                  // chiude.
                  dispatch({ type: 'SPACE_DELETE', payload: { id: chipMenu.spaceId } });
                  // La griglia di quel gruppo era salvata su una chiave
                  // localStorage suffissata: il reducer è puro e non può
                  // toccarla, quindi la si pulisce qui.
                  clearPanelGridStorage(chipMenu.spaceId);
                  setChipMenu(null);
                }}
                className={POPOVER_ITEM_DANGER}
                title="Le schede tornano nel gruppo principale"
              >
                <Trash2 size={14} />
                <span className="flex-1">Elimina gruppo</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
