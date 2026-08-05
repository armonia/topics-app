/**
 * SpaceGroups — i GRUPPI come CONTENITORE delle tab, nella sidebar.
 *
 * Un gruppo è un insieme di tab che vivi insieme, e qui si vede: il gruppo
 * aperto ha la sua intestazione e SOTTO, dentro di sé, la lista delle sue tab
 * (l'albero che questo componente riceve come figlio). Gli altri gruppi stanno
 * sopra, chiusi, una riga ciascuno.
 *
 * ── Cosa c'era prima, e perché non c'è più ─────────────────────────────────
 * Tre tentativi, tutti con lo stesso difetto: parlavano dei gruppi ALTROVE
 * rispetto alle tab che governavano.
 *   1. una striscia di chip sopra la griglia (a destra, lontanissima);
 *   2. una sezione "Gruppi" nella sidebar che ri-elencava le stesse tab in un
 *      albero parallelo — due liste della stessa cosa;
 *   3. una barra di chip in fondo alla sidebar (stile Arc/Dia): meglio, ma
 *      leggeva come un SECONDO concetto ("gli spazi") accanto ai gruppi, e due
 *      nomi per la stessa cosa sono peggio di zero.
 * Ora il gruppo è il contenitore, e non esiste nessun posto separato dove i
 * gruppi «vivono»: vivono attorno alle loro tab.
 *
 * ── Zero chrome finché non serve ───────────────────────────────────────────
 * Con il solo gruppo implicito non si disegna niente: nessuna intestazione
 * sopra l'unica lista possibile. Il primo gruppo nasce dal menu di una tab
 * ("Sposta nel gruppo → Nuovo gruppo"); da lì in poi il "+" sta qui, sul rail
 * dell'intestazione, e si accende passando sulla sidebar.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDismissable } from '../../hooks/useDismissable';
import { useMobile } from '../../hooks/useMobile';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX, type SpaceMeta, type Pane } from '../../state/pane/types';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { useSignalsStore, projectAttentionTier } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { useSpaceWindows } from '../../state/windowPresence';
import { focusSpaceWindow, popOutSpace } from '../../lib/popOutSpace';
import { SELECTED_SURFACE, ROW_INSET, TIER_DONE_BG, TIER_INPUT_BG } from '../../lib/selectionStyles';
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
 * Il tier di attenzione di un gruppo CHIUSO: il più forte fra i suoi pane
 * ('input' batte 'done'), o null. Costruito sugli STESSI insiemi per-soggetto
 * che leggono la barra delle tab e le righe della sidebar — parità di badge,
 * nessuna matematica privata di questo componente.
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

/** Larghezza minima del menu — così il clamp orizzontale non deve misurare
 *  (tienila in lockstep con il min-w qui sotto). */
const MENU_MIN_W = 190;

/** Separatore dello snapshot: un carattere di controllo che nessun titolo
 *  contiene, così encode/decode è totale. */
const SEP = '';

interface ChipMenuState {
  spaceId: string;
  x: number;
  y: number;
}

interface SpaceGroupsProps {
  /** L'albero delle tab del gruppo ATTIVO: è il contenuto del gruppo aperto,
   *  e viene reso dentro il suo contenitore. */
  children: ReactNode;
}

export function SpaceGroups({ children }: SpaceGroupsProps) {
  const dispatch = usePaneStore((s) => s.dispatch);
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const spaces = usePaneStore((s) => s.spaces);
  const panes = usePaneStore((s) => s.panes);
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const spaceWindows = useSpaceWindows();
  const { isMobile, isTouch } = useMobile();
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
  // decodificato sotto: iscriversi a `s.panes` ridisegnerebbe queste righe a
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

  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismissable({
    open: chipMenu !== null,
    onClose: () => setChipMenu(null),
    refs: [menuRef],
  });

  const ordered = useMemo(() => liveSpacesOrdered(spaces), [spaces]);
  const pinnedSpace = spaceWindowId();

  // Una pop-out `?topics=` salta ogni bridge del pane-store: lì l'albero si
  // disegna nudo. In una FINESTRA-GRUPPO invece l'intestazione resta — è
  // l'unica cosa che dice quale gruppo stai guardando — ma senza le altre
  // righe: da lì non si va da nessuna parte.
  if (isDetachedWindow()) return <>{children}</>;
  if (!pinnedSpace && ordered.length === 0) return <>{children}</>;

  const addSpace = () => {
    const id = createSpaceId();
    dispatch({ type: 'SPACE_UPSERT', payload: { space: { id, name: nextSpaceName(spaces) } } });
    dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id } });
  };

  const rows: { id: string; name: string }[] = [
    { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
    ...ordered.map((s) => ({ id: s.id, name: s.name || 'Gruppo' })),
  ];
  const activeRow = rows.find((r) => r.id === activeSpaceId) ?? rows[0];
  const others = pinnedSpace ? [] : rows.filter((r) => r.id !== activeRow.id);

  // «+» e comandi rari si accendono sull'hover della sidebar (desktop): tenerli
  // accesi sempre li trasforma in arredamento. Su mobile non esiste hover — lì
  // restano visibili, o sarebbero irraggiungibili. Il focus da tastiera li
  // rivela comunque.
  const revealOnHover = isMobile || isTouch
    ? ''
    : 'opacity-0 transition-opacity group-hover/sidebar:opacity-100 focus-visible:opacity-100';

  const openMenu = (spaceId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setRenameDraft(null);
    setChipMenu({ spaceId, x: e.clientX, y: e.clientY });
  };

  const goToSpace = (spaceId: string) => {
    // Staccato: il click porta in primo piano la SUA finestra. Se non c'è più
    // (chiusa, altra macchina), si ricade sul mostrarlo qui.
    const label = spaceWindows.get(spaceId);
    if (label) {
      void focusSpaceWindow(label).then((focused) => {
        if (!focused && spaceId !== activeSpaceId) {
          dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: spaceId } });
        }
      });
      return;
    }
    if (spaceId !== activeSpaceId) dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: spaceId } });
  };

  const menuSpace = chipMenu ? spaces[chipMenu.spaceId] : undefined;
  const menuDetachedLabel = chipMenu ? spaceWindows.get(chipMenu.spaceId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sidebar-groups">
      {/* I gruppi CHIUSI: una riga ciascuno, sopra quello aperto. Stanno qui e
          non in fondo alla sidebar perché sono la stessa cosa dell'apertura —
          un elenco solo, non una barra separata che parlerebbe di "spazi". */}
      {others.map((row) => {
        const detachedLabel = spaceWindows.get(row.id);
        const tier = spaceAttentionTier(row.id, panes, spaces, sig, topics, terminalSessions);
        return (
          <button
            key={row.id}
            role="tab"
            aria-selected={false}
            data-space-id={row.id}
            data-testid="space-row"
            onClick={() => goToSpace(row.id)}
            onContextMenu={(e) => openMenu(row.id, e)}
            className="group/row flex w-full flex-shrink-0 items-center gap-1.5 py-1 text-[12px] text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text"
            style={{ paddingLeft: ROW_INSET + 2, paddingRight: ROW_INSET }}
            title={detachedLabel ? `${row.name} — in una finestra sua (clic per portarla davanti)` : `Vai a ${row.name}`}
          >
            <ChevronRight size={12} className="flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{row.name}</span>
            {detachedLabel && (
              <AppWindow size={11} className="flex-shrink-0 text-app-text-tertiary" data-testid="space-detached" aria-label="in una finestra sua" />
            )}
            {tier && (
              <span
                aria-label={tier === 'input' ? 'richiede input' : 'attività completata'}
                className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  tier === 'input' ? `${TIER_INPUT_BG} animate-pulse` : TIER_DONE_BG
                }`}
              />
            )}
            <span className="flex-shrink-0 text-[11px] tabular-nums text-app-text-tertiary">
              {countBySpace.get(row.id) ?? 0}
            </span>
          </button>
        );
      })}

      {/* Il gruppo APERTO, e sotto — dentro di lui — le sue tab. */}
      <div
        role="tab"
        aria-selected
        data-space-id={activeRow.id}
        data-testid="space-row-active"
        onContextMenu={(e) => openMenu(activeRow.id, e)}
        className={`flex flex-shrink-0 items-center gap-1.5 py-1 text-[12px] font-medium text-app-text ${SELECTED_SURFACE}`}
        style={{ paddingLeft: ROW_INSET + 2, paddingRight: ROW_INSET }}
      >
        <ChevronDown size={12} className="flex-shrink-0 opacity-60" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{activeRow.name}</span>
        {(pinnedSpace || spaceWindows.has(activeRow.id)) && (
          <AppWindow size={11} className="flex-shrink-0 opacity-70" data-testid="space-detached" aria-label="in una finestra sua" />
        )}
        {!pinnedSpace && liveSpaceCount(spaces) < SPACES_MAX && (
          <button
            onClick={addSpace}
            className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-black/10 dark:hover:bg-white/10 ${revealOnHover}`}
            title="Nuovo gruppo"
            aria-label="Nuovo gruppo"
            data-testid="space-add"
          >
            <Plus size={12} />
          </button>
        )}
        <span className="flex-shrink-0 text-[11px] tabular-nums opacity-70">
          {countBySpace.get(activeRow.id) ?? 0}
        </span>
      </div>
      {/* Il contenuto del gruppo. Il filo a sinistra è ciò che rende visibile
          il "dentro": senza, l'intestazione sarebbe solo una riga che capita
          di stare sopra. */}
      <div className="flex min-h-0 flex-1 flex-col border-l-2 border-app-border/60" data-testid="space-content">
        {children}
      </div>

      {chipMenu && createPortal(
        <div
          ref={menuRef}
          className={`fixed ${POPOVER_SURFACE} min-w-[190px] overflow-y-auto overscroll-contain`}
          style={{
            top: chipMenu.y,
            left: Math.max(
              POPOVER_MARGIN,
              Math.min(chipMenu.x, window.innerWidth - MENU_MIN_W - POPOVER_MARGIN),
            ),
            maxHeight: `calc(100vh - ${chipMenu.y + POPOVER_MARGIN}px)`,
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
                  // Cancellazione morbida: le tab tornano nel gruppo principale
                  // (il reducer fa entrambe le mosse), niente si chiude.
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
