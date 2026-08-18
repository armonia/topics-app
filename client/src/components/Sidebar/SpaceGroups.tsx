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
import { useRef, useState, type ReactNode, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ChevronDown, ChevronRight, CornerDownLeft, Merge, Pencil } from 'lucide-react';
import { useDismissable } from '../../hooks/useDismissable';
import { usePaneStore } from '../../state/pane/store';
import { DEFAULT_SPACE_ID } from '../../state/pane/types';
import { focusSpaceWindow, popOutSpace, closeSpaceWindow } from '../../lib/popOutSpace';
import { DND_TYPES } from '../../lib/dndTypes';
import { ROW_GAP, ROW_GLYPH_SLOT, ROW_H, ROW_PX, TAB_LABEL_TYPE, TIER_DONE_BG, TIER_INPUT_BG } from '../../lib/selectionStyles';
import { useMobile } from '../../hooks/useMobile';
import { useLongPress, openContextMenuAt } from '../../hooks/useLongPress';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_MARGIN, POPOVER_DIVIDER, Z_POPOVER } from '../../lib/popoverStyles';
import { computeMenuPosition, type MenuPosition } from '@/lib/popoverPosition';
import { clearPanelGridStorage } from '../Layout/usePanelGridPersistence';
import { bringPaneIntoSpace, firstOtherLiveSpace } from '../Layout/spaceHelpers';
import { useGoToSpace, type SpaceCard } from './useSpaceCards';
import { useT } from '../../hooks/useT';

/** Larghezza minima del menu — così il clamp orizzontale non deve misurare
 *  (tienila in lockstep con il min-w qui sotto). */
const MENU_MIN_W = 190;

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
  const tr = useT();
  const dispatch = usePaneStore((s) => s.dispatch);
  const spaces = usePaneStore((s) => s.spaces);
  const goToSpace = useGoToSpace();
  const [menu, setMenu] = useState<CardMenuState | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissable({ open: menu !== null, onClose: () => setMenu(null), refs: [menuRef] });
  // Il menu si ancora al CURSORE, quindi il suo «trigger» e' un punto: si
  // costruisce un rettangolo di larghezza zero li' e si lascia decidere al
  // posizionatore, che misura il pannello vero, ribalta, e da' il tetto del
  // lato scelto. Vedi `useAnchoredPopover`.
  const [pos, setPos] = useState<MenuPosition | null>(null);
  useLayoutEffect(() => {
    // La misura va PRIMA che il browser dipinga, e in un effetto: leggere un
    // ref durante il render e' esattamente cio' che React vieta.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!menu) { setPos(null); return; }
    const el = menuRef.current;
    if (!el) return;
    setPos(computeMenuPosition(
      { top: menu.y, bottom: menu.y, left: menu.x, right: menu.x },
      { width: el.offsetWidth, height: el.offsetHeight },
      { gap: 0 },
    ));
  }, [menu]);

  const meta = spaces[card.id];
  const isDefault = card.id === DEFAULT_SPACE_ID;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const [dropping, setDropping] = useState(false);
  // «Il GRUPPO è l'unità» era un modello inutilizzabile dal telefono: rinominare,
  // staccare in una finestra, richiamare indietro, sciogliere — tutto e solo
  // dietro al tasto destro, e in questo file non c'era un solo `isTouch`.
  // Tenendo premuta l'intestazione si apre ORA lo stesso menu del mouse (evento
  // `contextmenu` sintetizzato sull'elemento che quel menu già ascolta), non un
  // secondo menu con metà voci.
  const { isTouch } = useMobile();
  const press = useLongPress(openContextMenuAt, { enabled: isTouch });

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
        const paneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB)
          || e.dataTransfer.getData(DND_TYPES.PANEL_ID);
        // NON `movePaneToSpace`: quella sposta una pane ESISTENTE, e una
        // tessera fissata con la tab chiusa non ha pane — cioè lo stato normale
        // di un fissato. Il drop diceva «porta questa cosa qui» e non faceva
        // niente, in silenzio.
        if (paneId) bringPaneIntoSpace(paneId, card.id);
      }}
      // Il TRATTEGGIO dice "questo gruppo non è disegnato qui": è in una
      // finestra sua. Il simbolo da solo era troppo poco — a colpo d'occhio la
      // card sembrava una card come le altre, e cliccarla sembrava un cambio di
      // gruppo invece che un salto a un'altra finestra.
      // Il fondo della card attiva è quello del «contenitore quieto», e adesso
      // è UNO solo: la stessa idea era dipinta con tre alpha diverse in tema
      // scuro — 0.03 nella fascia di una tessera fissata (PinnedTiles), 0.05
      // qui, 0.06 in SELECTED_SURFACE_SOFT — mentre in tema chiaro erano già
      // tutte 0.03. Una divergenza che si vede solo al buio e solo mettendo le
      // superfici affiancate, cioè come la sidebar si guarda sempre. Vale 0.06,
      // l'alpha che le altre due avevano già.
      // `my-[3px]`, non `mb-1`. Erano QUATTRO pixel, tutti da un lato solo:
      // ogni altra card della colonna porta mezzo passo per lato (`my-[3px]` =
      // COLUMN_GAP/2), così che fra due vicine ne cadano sei e la prima non
      // debba sapere chi ha sopra. Con l'aria tutta sotto, la distanza fra due
      // gruppi era 4 e quella fra un gruppo e ciò che gli sta SOPRA era zero.
      className={`mx-1.5 my-[3px] flex-shrink-0 overflow-hidden rounded-lg border transition-colors ${
        dropping
          ? 'border-primary bg-primary/10'
          : card.detachedLabel
            ? 'border-dashed border-app-border/70'
            : card.active
              ? 'border-app-border bg-black/[0.03] dark:bg-white/[0.06]'
              : 'border-app-border/50'
      }`}
    >
      <div
        role="tab"
        aria-selected={card.active}
        data-space-id={card.id}
        data-testid={card.active ? 'space-row-active' : 'space-row'}
        onContextMenu={(e) => { e.preventDefault(); setRenameDraft(null); setMenu({ x: e.clientX, y: e.clientY }); }}
        {...press.handlers}
        data-pressing={press.pressed || undefined}
        // Il clic-eco del long-press si mangia in CATTURA: l'`onClick` non sta
        // qui ma sui due bottoni dentro (freccia e nome), e fermare l'evento
        // prima che scenda è l'unico modo di coprirli entrambi senza ripetere
        // `consumeClick()` in ognuno. Senza, il menu si aprirebbe e un istante
        // dopo il gruppo cambierebbe sotto di esso.
        onClickCapture={(e) => { if (press.consumeClick()) { e.stopPropagation(); e.preventDefault(); } }}
        // ERA LA RIGA PIÙ BASSA DELLA SIDEBAR: nessuna altezza dichiarata, ~28px
        // di solo `py-1`, e nessuna variante mobile — cioè l'intestazione che
        // governa un intero gruppo era il bersaglio più piccolo dello schermo,
        // 16px sotto il minimo di iOS. Ora è l'altezza di riga di tutte le
        // altre, e non più ricopiata a mano: `ROW_H` vive in
        // `lib/selectionStyles` — il posto che questo commento indicava già.
        //
        // ANCHE IL PADDING VIENE DA LÌ, e prima era l'unico scritto come STILE
        // IN LINEA: `paddingLeft: 4, paddingRight: 6`. Due difetti in due
        // parole. Asimmetrico — 4 a sinistra contro 6 a destra, quando ogni
        // altra riga della colonna sta a 8 e 8 — e inline, cioè irraggiungibile
        // da qualunque media query e invisibile a Tailwind: nessun ramo `md:`
        // avrebbe mai potuto toccarlo.
        //
        // E la TIPOGRAFIA: 12px fissi, peso pieno solo da attiva. Questa riga ha
        // `role="tab"`, cioè è precisamente il caso che `TAB_LABEL` nomina per
        // primo («ovunque una tab si presenti»), ed era l'unica con quel ruolo
        // fuori dalla sua scala. Spegnere insieme peso E tono a riposo diceva
        // due volte ciò che la superficie dice già — è la regola che
        // `selectionStyles` dichiara e questa riga era rimasta a violarla.
        className={`flex select-none items-center ${ROW_GAP} ${ROW_H} ${ROW_PX} ${TAB_LABEL_TYPE} ${
          card.active ? 'text-app-text' : 'text-app-text-secondary'
        }`}
      >
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? tr('space.collapse', { name: card.name }) : tr('space.expand', { name: card.name })}
          // `tap-expand`: la freccia non allarga il BOX — sfonderebbe la riga —
          // e cresce solo l'area sensibile, ai 44px di iOS e solo su
          // `pointer: coarse`.
          //
          // Il box è `ROW_GLYPH_SLOT` (18) e non un `w-5` (20) scritto a mano:
          // è lo stesso contenitore in cui board, terminali e browser mettono il
          // loro glifo di testa, cioè ciò che fa partire tutti i nomi dalla
          // STESSA x. Due pixel, ma sono due pixel per ogni riga di questo tipo
          // e si leggono come una colonna storta.
          className={`tap-expand ${ROW_GLYPH_SLOT} h-5 rounded text-app-text-tertiary transition-colors hover:bg-black/10 dark:hover:bg-white/10`}
        >
          <Chevron size={12} aria-hidden="true" />
        </button>
        <button
          onClick={() => goToSpace(card.id)}
          className="min-w-0 flex-1 truncate text-left"
          title={card.detachedLabel
            ? tr('space.detachedTitle', { name: card.name })
            : card.active ? tr('space.currentTitle', { name: card.name }) : tr('space.switchTo', { name: card.name })}
        >
          {card.name}
        </button>
        {card.detachedLabel && (
          <span
            className="flex flex-shrink-0 items-center gap-1 rounded px-1 text-[10px] text-app-text-tertiary"
            data-testid="space-detached"
            aria-label={tr('space.detachedLabel')}
            title={tr('space.detachedOwnWindow', { name: card.name })}
          >
            <AppWindow size={11} />
            {tr('space.detachedChip')}
          </span>
        )}
        {card.tier && (
          <span
            aria-label={card.tier === 'input' ? tr('space.tier.input') : tr('space.tier.done')}
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
          // Mezzo passo, non quattro pixel: le righe dentro portano già il loro
          // `my-[3px]`, quindi 3 qui fanno 6 fra l'ultima riga e il bordo della
          // card — la stessa aria che c'è fra due righe. È la regola della
          // colonna («ognuno porta metà passo»), che questo contenitore era
          // rimasto l'unico a non seguire.
          className="pb-[3px]"
        >
          {children}
        </div>
      )}

      {menu && createPortal(
        <div
          ref={menuRef}
          className={`fixed ${POPOVER_SURFACE} min-w-[190px] overflow-y-auto overscroll-contain`}
          style={{
            // Il tetto e' ancorato alla FINESTRA, non al cursore.
            //
            // Era `calc(100vh - y - 8)`: su desktop, con la barra di stato in
            // fondo, il pavimento vero e' `innerHeight - 38`, quindi un menu da
            // 107px si apriva con 30px di tetto — una fessura. Su mobile la
            // barra di stato sale in cima e resta la sola safe-area: l'argomento
            // andava NEGATIVO, CSS clampa `max-height` a 0, e il tocco lungo
            // «non faceva niente».
            //
            // E `top` non e' piu' il cursore nudo: il menu si misura e ribalta
            // sopra quando sotto non ci sta.
            top: pos?.top ?? menu.y,
            left: pos?.left ?? Math.max(POPOVER_MARGIN, Math.min(menu.x, window.innerWidth - MENU_MIN_W - POPOVER_MARGIN)),
            maxHeight: pos?.maxHeight ?? Math.max(160, window.innerHeight - POPOVER_MARGIN * 2),
            zIndex: Z_POPOVER,
            visibility: pos ? 'visible' : 'hidden',
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
                  placeholder={tr('space.renamePlaceholder')}
                  aria-label={tr('space.renameLabel')}
                />
              </form>
            ) : (
              <button onClick={() => setRenameDraft(meta.name)} className={POPOVER_ITEM}>
                <Pencil size={14} />
                <span className="flex-1">{tr('space.rename')}</span>
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
              ? tr('space.alreadyDetached')
              : tr('space.detach')}
            data-testid="space-detach"
          >
            <AppWindow size={14} />
            <span className="flex-1">{card.detachedLabel ? tr('space.goToWindow') : tr('space.moveToWindow')}</span>
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
              title={tr('space.reattachTitle')}
              data-testid="space-reattach"
            >
              <CornerDownLeft size={14} />
              <span className="flex-1">{tr('space.reattach')}</span>
            </button>
          )}
          {!isDefault && meta && !meta.deleted && (
            <>
              <div className={POPOVER_DIVIDER} />
              {/* Non è una cancellazione, ed è un errore chiamarla così: le tab
                  tornano tutte nel gruppo principale e niente si chiude — il
                  reducer fa entrambe le mosse. Con «Elimina» e il cestino rosso
                  il gesto sembrava distruttivo, quindi non lo si usava per la
                  cosa che invece fa benissimo: rimettere insieme. */}
              <button
                onClick={() => {
                  dispatch({ type: 'SPACE_DELETE', payload: { id: card.id } });
                  // La griglia di quel gruppo era salvata su una chiave
                  // localStorage suffissata: il reducer è puro e non può
                  // toccarla, quindi la si pulisce qui.
                  clearPanelGridStorage(card.id);
                  setMenu(null);
                }}
                className={POPOVER_ITEM}
                title={tr('space.dissolveTitle')}
                data-testid="space-dissolve"
              >
                <Merge size={14} />
                <span className="flex-1">{tr('space.dissolve')}</span>
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
