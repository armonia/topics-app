/**
 * SpaceGroups — i GRUPPI come CARD che avvolgono le loro tab, nella sidebar.
 *
 * Un gruppo è un insieme di tab che vivi insieme, e qui si vede letteralmente:
 * ogni gruppo è una card con la sua intestazione e dentro, racchiuse, le sue
 * tab. Ci sono TUTTI i gruppi contemporaneamente, e ognuno si apre e si chiude
 * per conto suo con la freccia — come fanno i progetti.
 *
 * ── Cosa c'era prima, e perché non c'è più ─────────────────────────────────
 * Quattro tentativi, e i primi tre parlavano dei gruppi ALTROVE rispetto alle
 * tab che governavano:
 *   1. una striscia di chip sopra la griglia (a destra, lontanissima);
 *   2. una sezione "Gruppi" nella sidebar che ri-elencava le stesse tab in un
 *      albero parallelo — due liste della stessa cosa;
 *   3. una barra di chip in fondo alla sidebar (stile Arc/Dia): meglio, ma
 *      leggeva come un SECONDO concetto ("gli spazi") accanto ai gruppi.
 *   4. un solo gruppo aperto alla volta, con gli altri come righe chiuse
 *      sopra: il contenitore c'era, ma i gruppi si ALTERNAVANO — per vedere
 *      cosa c'era nell'altro dovevi lasciare quello in cui eri, e la sidebar
 *      continuava a mostrare una lista sola alla volta.
 * Ora ci sono tutti, ognuno tiene in mano le sue tab, e nessuno sparisce per
 * far posto a un altro.
 *
 * ── Gruppo APERTO ≠ gruppo ATTIVO ──────────────────────────────────────────
 * L'accordion dice cosa VEDI nella sidebar; il gruppo ATTIVO dice cosa vive
 * nella griglia (`activeSpaceId`, device-local). Sono due cose diverse apposta:
 * puoi guardare l'elenco di un altro gruppo senza portarci dentro la finestra.
 * Cliccare una sua riga invece ci porta — la card intercetta il clic in cattura
 * e commuta il gruppo prima che la riga apra la sua pane, altrimenti aprirebbe
 * qualcosa che resta invisibile.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ChevronDown, ChevronRight, CornerDownLeft, Pencil, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDismissable } from '../../hooks/useDismissable';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, type SpaceMeta, type Pane } from '../../state/pane/types';
import { getTerminalSessionFromPaneId } from '../../state/pane/adapters';
import { useSignalsStore, projectAttentionTier } from '../../state/signals';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { useSpaceWindows } from '../../state/windowPresence';
import { focusSpaceWindow, popOutSpace, closeSpaceWindow, claimSpaceLocally } from '../../lib/popOutSpace';
import { DND_TYPES } from '../../lib/dndTypes';
import { ROW_INSET, TIER_DONE_BG, TIER_INPUT_BG } from '../../lib/selectionStyles';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_MARGIN, POPOVER_ITEM_DANGER, POPOVER_DIVIDER, Z_POPOVER } from '../../lib/popoverStyles';
import { clearPanelGridStorage } from '../Layout/usePanelGridPersistence';
import {
  DEFAULT_SPACE_LABEL,
  firstOtherLiveSpace,
  liveSpacesOrdered,
  movePaneToSpace,
} from '../Layout/spaceHelpers';
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
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.id === activeSpaceId,
      count: countBySpace.get(r.id) ?? 0,
      tier: spaceAttentionTier(r.id, panes, spaces, sig, topics, terminalSessions),
      detachedLabel: spaceWindows.get(r.id),
    }));
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

interface CardMenuState {
  x: number;
  y: number;
}

interface SpaceGroupCardProps {
  card: SpaceCard;
  /** Accordion: la card è aperta? */
  expanded: boolean;
  onToggle: () => void;
  /** Le righe del gruppo: le sue tab. */
  children: ReactNode;
}

/**
 * Un gruppo, disegnato: intestazione + le sue tab racchiuse dentro.
 *
 * Il bordo non è decorazione — è ciò che rende visibile il "dentro". Senza,
 * l'intestazione sarebbe solo una riga che capita di stare sopra ad altre.
 */
export function SpaceGroupCard({ card, expanded, onToggle, children }: SpaceGroupCardProps) {
  const dispatch = usePaneStore((s) => s.dispatch);
  const spaces = usePaneStore((s) => s.spaces);
  const goToSpace = useGoToSpace();
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissable({ open: menu !== null, onClose: () => setMenu(null), refs: [menuRef] });

  const meta = spaces[card.id];
  const isDefault = card.id === DEFAULT_SPACE_ID;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const [dropping, setDropping] = useState(false);

  // ── Trascinare una tab dentro un gruppo ──────────────────────────────────
  // Le sorgenti sono due e le porta già il resto dell'app: una riga della
  // sidebar (`PANEL_ID`) e una tab della barra (`PANE_TAB`, che è l'id della
  // pane — quello buono). Durante il dragover il contenuto non è leggibile per
  // sicurezza: si guardano i TIPI, e il valore si legge al drop.
  //
  // Fra FINESTRE funziona senza plumbing nativo: le card ci sono in ogni
  // finestra, anche quelle dei gruppi staccati, e spostare una tab in un
  // gruppo che vive di là la fa comparire di là (il pane-store è sincronizzato,
  // LWW + server_seq). Trascinare fisicamente da una finestra all'altra invece
  // no: due WKWebView non si passano un drag HTML5, e nessun trucco lo cambia.
  const dragCarriesPane = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(DND_TYPES.PANE_TAB) ||
    e.dataTransfer.types.includes(DND_TYPES.PINNED_PANE_ID) ||
    e.dataTransfer.types.includes(DND_TYPES.PANEL_ID);

  return (
    <div
      data-space-id={card.id}
      data-testid={card.active ? 'space-card-active' : 'space-card'}
      onDragOver={(e) => {
        if (!dragCarriesPane(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        // Solo quando si esce DAVVERO dalla card: `dragleave` scatta anche
        // passando da un figlio all'altro.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        if (!dragCarriesPane(e)) return;
        e.preventDefault();
        e.stopPropagation();
        // `PINNED_PANE_ID` prima di `PANEL_ID`: una tessera fissata porta
        // entrambi, e per un progetto solo il primo è l'id di una pane vera.
        const paneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB)
          || e.dataTransfer.getData(DND_TYPES.PINNED_PANE_ID)
          || e.dataTransfer.getData(DND_TYPES.PANEL_ID);
        if (paneId) movePaneToSpace(paneId, card.id);
      }}
      // Il TRATTEGGIO dice "questo gruppo non è disegnato qui": è in una
      // finestra sua. Il simbolo da solo era troppo poco — a colpo d'occhio la
      // card sembrava una card come le altre, e cliccarla sembrava un cambio di
      // gruppo invece che un salto a un'altra finestra.
      className={`mx-1.5 mb-1 flex-shrink-0 overflow-hidden rounded-lg border transition-colors ${
        dropping
          ? 'border-primary bg-primary/10'
          : card.detachedLabel
            ? 'border-dashed border-app-border/70'
            : card.active
              ? 'border-app-border bg-black/[0.03] dark:bg-white/[0.05]'
              : 'border-app-border/50'
      }`}
    >
      <div
        role="tab"
        aria-selected={card.active}
        data-space-id={card.id}
        data-testid={card.active ? 'space-row-active' : 'space-row'}
        onContextMenu={(e) => { e.preventDefault(); setRenameDraft(null); setMenu({ x: e.clientX, y: e.clientY }); }}
        className={`flex items-center gap-1 py-1 text-[12px] ${
          card.active ? 'font-medium text-app-text' : 'text-app-text-secondary'
        }`}
        style={{ paddingLeft: 4, paddingRight: ROW_INSET }}
      >
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Chiudi ${card.name}` : `Apri ${card.name}`}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-app-text-tertiary transition-colors hover:bg-black/10 dark:hover:bg-white/10"
        >
          <Chevron size={12} aria-hidden="true" />
        </button>
        <button
          onClick={() => goToSpace(card.id)}
          className="min-w-0 flex-1 truncate text-left"
          title={card.detachedLabel
            ? `${card.name} — in una finestra sua (clic per portarla davanti)`
            : card.active ? `${card.name}: è il gruppo che stai usando` : `Passa a ${card.name}`}
        >
          {card.name}
        </button>
        {card.detachedLabel && (
          <span
            className="flex flex-shrink-0 items-center gap-1 rounded px-1 text-[10px] text-app-text-tertiary"
            data-testid="space-detached"
            aria-label="in una finestra sua"
            title={`${card.name} vive in una finestra sua`}
          >
            <AppWindow size={11} />
            finestra
          </span>
        )}
        {card.tier && (
          <span
            aria-label={card.tier === 'input' ? 'richiede input' : 'attività completata'}
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
              card.tier === 'input' ? `${TIER_INPUT_BG} animate-pulse` : TIER_DONE_BG
            }`}
          />
        )}
        <span className="flex-shrink-0 text-[11px] tabular-nums text-app-text-tertiary">{card.count}</span>
      </div>

      {expanded && (
        <div
          data-testid={card.active ? 'space-content' : 'space-content-inactive'}
          // Cattura: cliccare una riga di un gruppo che non è quello attivo
          // deve PRIMA portarci la finestra, altrimenti la pane si aprirebbe
          // dove non la vedi. In cattura, cioè prima che la riga faccia la sua
          // parte, e il dispatch di zustand è sincrono: quando la riga apre, il
          // gruppo giusto è già quello.
          onClickCapture={card.active ? undefined : () => goToSpace(card.id)}
          className="pb-1"
        >
          {children}
        </div>
      )}

      {menu && createPortal(
        <div
          ref={menuRef}
          className={`fixed ${POPOVER_SURFACE} min-w-[190px] overflow-y-auto overscroll-contain`}
          style={{
            top: menu.y,
            left: Math.max(POPOVER_MARGIN, Math.min(menu.x, window.innerWidth - MENU_MIN_W - POPOVER_MARGIN)),
            maxHeight: `calc(100vh - ${menu.y + POPOVER_MARGIN}px)`,
            zIndex: Z_POPOVER,
          }}
          data-testid="space-menu"
        >
          {meta && !meta.deleted && (
            renameDraft !== null ? (
              <form
                className="px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = renameDraft.trim();
                  if (name) dispatch({ type: 'SPACE_UPSERT', payload: { space: { id: card.id, name } } });
                  setMenu(null);
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
              <button onClick={() => setRenameDraft(meta.name)} className={POPOVER_ITEM}>
                <Pencil size={14} />
                <span className="flex-1">Rinomina</span>
              </button>
            )
          )}
          <button
            onClick={() => {
              setMenu(null);
              if (card.detachedLabel) { void focusSpaceWindow(card.detachedLabel); return; }
              void popOutSpace(card.id).then((ok) => {
                if (!ok) return;
                // Il gruppo ora vive di là: questa finestra lo MOLLA, o le due
                // disegnano la stessa griglia (è il "la finestra è duplicata").
                if (card.id !== usePaneStore.getState().activeSpaceId) return;
                const next = firstOtherLiveSpace(usePaneStore.getState().spaces, card.id);
                if (next) dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: next } });
              });
            }}
            className={POPOVER_ITEM}
            title={card.detachedLabel
              ? 'È già in una finestra sua: la porto davanti'
              : 'Il gruppo si apre in una finestra sua; le sue tab restano queste'}
            data-testid="space-detach"
          >
            <AppWindow size={14} />
            <span className="flex-1">{card.detachedLabel ? 'Vai alla sua finestra' : 'Sposta in una finestra'}</span>
          </button>
          {card.detachedLabel && (
            <button
              onClick={() => {
                const label = card.detachedLabel!;
                setMenu(null);
                // Riprenderselo = chiudere la sua finestra e riaprirlo qui. Le
                // tab non si toccano: cambia solo CHI le disegna.
                void closeSpaceWindow(label).then(() => {
                  dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: card.id } });
                });
              }}
              className={POPOVER_ITEM}
              title="Chiude la sua finestra e riporta il gruppo qui"
              data-testid="space-reattach"
            >
              <CornerDownLeft size={14} />
              <span className="flex-1">Riporta in questa finestra</span>
            </button>
          )}
          {!isDefault && meta && !meta.deleted && (
            <>
              <div className={POPOVER_DIVIDER} />
              <button
                onClick={() => {
                  // Cancellazione morbida: le tab tornano nel gruppo principale
                  // (il reducer fa entrambe le mosse), niente si chiude.
                  dispatch({ type: 'SPACE_DELETE', payload: { id: card.id } });
                  // La griglia di quel gruppo era salvata su una chiave
                  // localStorage suffissata: il reducer è puro e non può
                  // toccarla, quindi la si pulisce qui.
                  clearPanelGridStorage(card.id);
                  setMenu(null);
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

/*
 * Qui stava "Nuovo gruppo", sotto le card: creava un gruppo VUOTO e ci portava
 * dentro. Tolto, perché un gruppo vuoto non è uno stato utile — l'unico modo in
 * cui un gruppo nasce davvero è portandoci una tab, e quella strada esiste già
 * nel menu contestuale della tab («Sposta nel gruppo → Nuovo gruppo», in
 * PaneTabBar): crea il gruppo E ci mette dentro qualcosa, in un gesto solo.
 * Due comandi con lo stesso nome per due esiti diversi erano solo un modo di
 * sbagliare.
 */
