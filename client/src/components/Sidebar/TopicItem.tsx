import { useCallback, memo } from 'react';
import { ChevronRight, Cloud, Pin, AppWindow } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Topic } from '@/types';
import { useTopicPendingStatus } from '@/contexts/PendingActionContext';
import { PendingActionRing } from '@/components/Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '@/components/Shared/PendingActionProgressOverlay';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { rememberDraggedPane } from '@/lib/dragPayload';
import { startDragPreview } from '@/lib/dragPreview';
import { getProjectLabel } from '@/lib/buildSidebarItems';
import { DND_TYPES } from '@/lib/dndTypes';
import { useTopicLoading, useTopicAttentionFill, useSeenDwell } from '@/state/signals';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { TopicSubline } from '@/components/Shared/SessionActivity';
import { RelativeTime } from '@/components/Shared/RelativeTime';
import { TopicStreamingSpinner } from '@/components/Layout/StreamingIndicator';
import { sidebarRowCard, ROW_PX, ROW_GAP, ROW_H, ROW_INSET, ROW_ACTION_BOX, ROW_ACTION_GLYPH, ROW_CHEVRON, ROW_CHEVRON_SLOT, ROW_GLYPH_SLOT, ROW_CARD, ROW_TRAIL, ROW_ACTIONS, ARCHIVED_ROW, TAB_LABEL_TYPE, SIDEBAR_INDENT_STEP, ON_FILL_TEXT, ON_FILL_TEXT_SOFT } from '@/lib/selectionStyles';
import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';
import { useMobile } from '@/hooks/useMobile';
import { useLongPress, openContextMenuAt } from '@/hooks/useLongPress';
import { useTouchDrag } from '@/hooks/useTouchDrag';
import { useT } from '@/hooks/useT';

/* L'altezza della riga NON è più dichiarata qui: è {@link ROW_H} in
 * `lib/selectionStyles`, importata sopra. Stava in questo file come costante di
 * modulo — quindi TopicTree la ridichiarava e SpaceGroups la ricopiava a mano —
 * e il commento che portava lo ammetteva già («il posto suo è
 * lib/selectionStyles, accanto a ROW_PX e ROW_INSET», SpaceGroups.tsx). Il
 * perché dei due numeri, e perché il predicato è la larghezza e mai `isTouch`,
 * sta accanto alla costante. */

interface TopicItemProps {
  topic: Topic;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isOpen: boolean;
  isFocused: boolean;
  isPreview?: boolean;
  isArchived?: boolean;
  isProject?: boolean;
  /** Unified attention count — server unread OR Claude "needs you". Rendered as
   *  the same NotificationBadge the tab bar uses; the per-Claude phase dot is
   *  gone, folded into this single count. */
  notificationCount?: number;
  onToggle: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onArchive?: (topicId: string, archive: boolean) => void;
  onStopStreaming?: () => void;
  /** Pinned ("Fissati") — renders the Pin glyph in the trailing rail and the
   *  row survives tab close (see buildSidebarItems pinnedIds gates). */
  pinned?: boolean;
  /* `onTogglePin` non esiste più: il suo unico consumatore era il menu overflow
     a 2 voci che questa riga montava su touch, e quello è sparito quando il
     «...» ha iniziato ad aprire lo STESSO menu del tasto destro (dove il
     «Fissa» c'è già, passato al ContextMenu da App). Restava dichiarata solo
     perché TopicTree continuava a passarla, e quindi andava anche destrutturata
     come `_onTogglePin` per non violare noUnusedLocals: una prop morta che si
     portava dietro due righe di zavorra in due file. */
  /** Set when this topic is open in ANOTHER window (pop-out presence). Renders
   *  the trailing AppWindow glyph; the row click focuses that window. */
  detachedWindowLabel?: string;
  sortable?: boolean;
  /** IL TRASPORTO DEL DITO. Col mouse la riga si trascina da sé (`draggable` +
   *  `dragstart`), e chi la riceve la fissa. Su iOS quegli eventi da un tocco
   *  non arrivano mai, quindi il gesto va costruito: chi disegna la riga dice
   *  dove finisce il punto, e la riga si limita a portarglielo. Assente ⇒ la
   *  riga non si trascina col dito, e tiene il long-press di sempre.
   *
   *  Le funzioni ricevono l'id della pane invece di chiuderci sopra, così
   *  l'oggetto è UNO per tutta la sidebar e resta identico fra due render: la
   *  riga è `memo`, e una closure nuova per riga la sveglierebbe tutte a ogni
   *  battito. */
  touchDrag?: {
    onLift?: (paneId: string) => void;
    onMove?: (paneId: string, x: number, y: number) => void;
    onDrop?: (paneId: string, x: number, y: number) => void;
    onCancel?: () => void;
  };
  /* `hideIcon` non c'è più: il suo unico compito era spegnere il glifo
     `Archive` sulle sotto-righe di un progetto, e quel glifo non esiste più
     (vedi ARCHIVED_ROW). Una prop che governa una cosa sparita è zavorra in due
     file — quello che la dichiara e quello che continua a passarla. */
}

export const TopicItem = memo(function TopicItem({
  topic,
  depth,
  hasChildren,
  isExpanded,
  isOpen,
  isFocused,
  isPreview,
  isArchived,
  isProject: _isProject,
  notificationCount = 0,
  onToggle,
  onClick,
  onDoubleClick,
  onContextMenu,
  onArchive,
  onStopStreaming,
  pinned,
  detachedWindowLabel,
  sortable,
  touchDrag,
}: TopicItemProps) {
  // Depth indent lives on the LEFT MARGIN, not padding — so a sub-tab's CARD
  // shifts right (leaving an empty gutter) instead of just indenting its text
  // inside a full-width card. Base = the card's own inset (ROW_INSET),
  // so depth-0 children line up with the card edge.
  const marginLeft = ROW_INSET + depth * SIDEBAR_INDENT_STEP;
  // Fonte UNICA di «siamo su touch». Prima era una costante di modulo, valutata
  // una volta all'import: non reagiva mai — né a un iPad che cambia modalità né
  // a una finestra spostata su un altro schermo — e diceva la sua a ogni riga.
  const { isTouch, hasHover } = useMobile();
  // Canonical streaming signal — same context the chat tab reads. No
  // upstream prop needed; deduplicates the wiring across surfaces.
  const tr = useT();
  const isStreaming = useTopicLoading(topic.id);
  // Attention TIER — amber 'input' (a permission gate, act now) vs blue 'done'
  // (turn finished, look when ready), or null. Same signal/look the chat tab
  // uses, so the sidebar row and the tab can't drift (tabbar ≡ sidebar
  // invariant).
  //
  // Il FILL cade quando la riga è stata VISTA, non quando è selezionata: prima il
  // gate era `!isFocused`, e un clic di passaggio spegneva il fill di una chat mai
  // letta. `useSeenDwell` arma la soglia mentre la riga è davanti e la finestra è
  // sveglia; `useTopicAttentionFill` applica FOCUS WINS in un posto solo.
  useSeenDwell(topic.id, isFocused);
  const attentionTier = useTopicAttentionFill(topic.id);
  const onFill = attentionTier !== null;
  // Where this topic's pane sits in the standalone split grid (undefined unless
  // it's open AND the grid is split). Rendered as the same proportional
  // mini-map the tab shows, so the sidebar card mirrors the tab's position cue.
  const splitPosition = useSplitPosition(topic.id);

  const { attributes: sortableAttributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: topic.id,
    disabled: !sortable,
  });
  // Exclude aria-disabled from sortable attributes — it prevents Playwright clicks
  // and isn't meaningful for treeitem semantics (the item is always interactive, just not always draggable)
  const { 'aria-disabled': _ariaDisabled, role: _role, ...attributes } = sortableAttributes;

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    marginLeft,
  };

  // Tieni premuto = tasto destro. Su touch il menu contestuale non aveva altra
  // porta, e quella che c'era — il «...» con dentro Fissa e Archivia — era un
  // SOTTOINSIEME muto delle 6 voci del tasto destro (mancavano Rinomina, Cambia
  // colore, Copia link, Apri in nuova finestra). `openContextMenuAt` sintetizza
  // l'evento `contextmenu` che l'`onContextMenu` qui sotto già ascolta: un menu
  // solo, per costruzione, che non può più divergere.
  // ...e MUOVENDO il dito la riga si trascina, dove chi la disegna ha un
  // trasporto da offrire (oggi: la griglia dei fissati). È lo stesso gesto in
  // due esiti, quello della schermata Home: `useTouchDrag` serve il menu al
  // rilascio senza spostamento, e il trascinamento se il dito si muove. Senza
  // un `touchDrag` la riga non ha dove andare, e resta il long-press di prima:
  // lì il menu si apre al timer, col dito ancora giù, ed è il gesto che ogni
  // altra superficie della sidebar ha oggi.
  const lpMenu = useLongPress(openContextMenuAt, { enabled: isTouch && !touchDrag });
  const lpDrag = useTouchDrag({
    enabled: isTouch && !!touchDrag,
    onPress: openContextMenuAt,
    onLift: touchDrag ? () => touchDrag.onLift?.(topic.id) : undefined,
    onMove: touchDrag ? (x, y) => touchDrag.onMove?.(topic.id, x, y) : undefined,
    onDrop: touchDrag ? (x, y) => touchDrag.onDrop?.(topic.id, x, y) : undefined,
    onCancel: touchDrag ? () => touchDrag.onCancel?.() : undefined,
  });
  const lp = touchDrag ? lpDrag : lpMenu;

  // UN PREDICATO SOLO PER «ARCHIVIATA», e prima erano due.
  //
  // La riga leggeva `isArchived` (la prop, che TopicTree calcola dall'item) per
  // il tono e per il glifo in testa, e `topic.archived` (il campo) per il
  // comando in coda. Coincidono quasi sempre, ed è proprio questo il guaio: nel
  // momento in cui divergono — un aggiornamento ottimistico, una riga costruita
  // da una lista non ancora riconciliata — la riga si dipinge da ARCHIVIATA e in
  // coda ti offre «Archivia». Due sorgenti per un booleano non sono ridondanza,
  // sono un bug che aspetta.
  const archived = isArchived ?? !!topic.archived;

  // v3 foundations sidebar↔topbar sync: aggregate the topic-level closing
  // countdown across BOTH surfaces. The sidebar row shows the progress
  // overlay whether the close was initiated from:
  //   - il cerchio in coda alla riga         → `archive-topic:<id>`
  //   - the X on the open chat tab (topbar)  → `close-tab:chat:<id>`
  // Without this aggregation the sidebar stays static when the user closes
  // the tab from the topbar, even though the chat-pane countdown is running.
  const pendingArchiveStatus = useTopicPendingStatus(topic.id, {
    isArchived: archived,
  });

  // Un solo verso, deciso dallo stato: aperta → archivia, archiviata →
  // ripristina. Prima erano due handler con due etichette e due glifi; il
  // cerchio non ha bisogno di sapere quale dei due sta facendo, perché la sua
  // forma lo dice già.
  const toggleArchive = useCallback(() => {
    onArchive?.(topic.id, !archived);
  }, [topic.id, archived, onArchive]);

  // Native HTML5 drag SOURCE for the sidebar row (restores the drag that a
  // dnd-kit migration + DndContext removal left dead — see PanelGrid's sidebar
  // drop path). Carries PANEL_ID so the grid's cell drop-targets can OPEN the
  // topic and MERGE it into the group it's dropped on ("raggruppa da sidebar").
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(DND_TYPES.PANEL_ID, topic.id);
    rememberDraggedPane(topic.id);
    e.dataTransfer.effectAllowed = 'move';
    // COSA HO IN MANO: la scheda intera, decisa in un posto solo
    // (`lib/dragPreview`). La riga porta un nome, il progetto in cui vive e i
    // segnali che la stanno chiamando: chi trascina deve riconoscere la cosa,
    // e fra due chat omonime di due progetti diversi il nome da solo non basta.
    // Niente glifo e niente `accent`: la riga non li porta. Il glifo davanti al
    // nome di una chat non c'è per scelta («solo le sessioni agente hanno un
    // marchio»), e `topic.color` è un default inventato che la sidebar non
    // dipinge da nessuna parte. Un'anteprima che mostra ciò che la cosa non ha
    // non è l'anteprima della cosa.
    startDragPreview(e, {
      title: topic.name,
      subtitle: topic.projectPath ? getProjectLabel(topic.projectPath) : undefined,
      badges: [
        notificationCount > 0 ? String(notificationCount) : '',
        archived ? 'archiviata' : '',
      ].filter(Boolean),
    });
  }, [topic.id, topic.name, topic.projectPath, notificationCount, archived]);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      {
        // Dopo `listeners` di proposito: se dnd-kit montasse handler di touch,
        // il gesto della riga deve restare uno solo — questo.
        ...lp.handlers
      }
      data-pressing={lp.pressed || undefined}
      // Il drag nativo si spegne solo dove NON c'è un puntatore: il lift di
      // HTML5 contende lo stesso dito del long-press, e vince lui.
      //
      // `!isTouch` non basta come condizione, ed era lo stesso errore che il
      // blocco in cima a `useMobile` racconta: su un ibrido (portatile
      // touchscreen, iPad col trackpad) `isTouch` è vero MA il mouse c'è, e
      // spegnere lì il drag toglie l'unico trasporto che la riga ha — la
      // sidebar non monta un `DndContext`, quindi i `listeners` di `useSortable`
      // sono inerti e resta solo `handleDragStart`. Trascinare una chat nella
      // griglia diventava impossibile con il mouse, su una macchina che il mouse
      // ce l'ha. Con `hasHover` il dito ha il suo gesto e il mouse il suo.
      draggable={(hasHover || !isTouch) && !archived}
      onDragStart={handleDragStart}
      role="treeitem"
      aria-selected={isFocused}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-label={topic.name}
      tabIndex={isFocused ? 0 : -1}
      data-pinned={pinned ? 'true' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent);
        }
        if (e.key === 'ArrowRight' && hasChildren && !isExpanded) {
          e.preventDefault();
          onToggle();
        }
        if (e.key === 'ArrowLeft' && hasChildren && isExpanded) {
          e.preventDefault();
          onToggle();
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement;
          next?.focus();
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement;
          prev?.focus();
        }
      }}
      className={cn(
        // Card rows — same visual language as the tab-bar tabs: a rounded,
        // self-contained surface with its own faint fill, not a full-bleed
        // list row with hairline dividers. `overflow-hidden` clips the
        // soft-archive progress fill to the rounded corners.
        // Shared card styling (see sidebarRowCard) — same look for every
        // sidebar row type. No border (hairlines read as dividing lines); a
        // filled inset rounded surface makes each row a tab-like card.
        // L'altezza è quella di TUTTE le righe d'albero (ROW_H): questa faceva
        // eccezione con 40/34 mentre le sorelle stavano a 44/32, e su touch 40px
        // sono sotto il minimo di tap target di iOS.
        // `ROW_CARD` è il primo dei tre pezzi del contratto della coda (vedi
        // ROW_ACTIONS in selectionStyles): senza, il comando in coda non si
        // accende al passaggio del mouse. Il `relative` che gli serve lo porta
        // già `sidebarRowCard`.
        `group ${ROW_CARD} flex items-center ${ROW_GAP} ${ROW_H} ${ROW_PX} cursor-pointer ${TAB_LABEL_TYPE} select-none`,
        sidebarRowCard({ focused: isFocused, open: isOpen, attention: attentionTier, nested: depth > 0 }),
        // Preview panels show italic name
        isPreview && 'italic',
        archived && ARCHIVED_ROW,
        isDragging && 'opacity-50'
      )}
      style={sortableStyle}
      // Il clic che il browser sintetizza dopo un long-press andato a segno si
      // mangia qui: senza, il menu si aprirebbe e la riga si attiverebbe sotto.
      onClick={(e) => { if (lp.consumeClick()) return; onClick(e); }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/* Pending-action progress fill — runs over the whole row L→R during
          the 3 s soft-archive countdown. Sits behind everything (no z
          index) so the sidebar accent border + content render on top. */}
      {pendingArchiveStatus && (
        <PendingActionProgressOverlay status={pendingArchiveStatus} />
      )}

      {/* "Awaiting feedback" is the row's own electric-blue background now
          (see sidebarRowCard awaiting flag), not an overlay. */}

      {/* THE ACCORDION COLUMN, RESERVED EVEN WHEN THERE IS NO ACCORDION.
          The toggle only exists on a row with children, but the SLOT exists on
          every row: without the empty branch a chat without children started
          `ROW_CHEVRON_SLOT` + `ROW_GAP` (12 + 8 = 20px) left of a chat with
          children, so the same column carried two alignments. Reported on the
          board (card 150ebafb): a row without an accordion starts further left
          than a row that has one. */}
      {hasChildren ? (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-label={isExpanded ? 'Comprimi' : 'Espandi'}
          aria-expanded={isExpanded}
          // The SHARED accordion slot, same box as the project row and the
          // pinned tile: the chevron ink starts at the row inset, so the three
          // chevrons of the column line up instead of landing at 8, 10 and 11.
          className={`${ROW_CHEVRON_SLOT} tap-expand-y h-full transition-colors`}
        >
          <ChevronRight
            size={ROW_CHEVRON}
            className={cn('transition-transform duration-150', isExpanded && 'rotate-90')}
          />
        </button>
      ) : (
        <span aria-hidden="true" data-row-chevron-slot="empty" className={ROW_CHEVRON_SLOT} />
      )}

      {/* IL GLIFO D'ARCHIVIO IN TESTA NON C'È PIÙ, ed è la metà visibile della
          decisione «uno stato solo» (vedi ARCHIVED_ROW in selectionStyles).
          Diceva una terza volta ciò che il tono della riga e il cerchio in coda
          dicono già, e lo diceva nell'unico posto che costa una COLONNA: con
          quel glifo il nome di una chat archiviata partiva a 36px dal bordo
          della card e quello di una chat viva a 8 — due incolonnamenti nella
          stessa lista, per una differenza che non è di tipo ma di stato.
          Adesso ogni chat comincia allo stesso pixel, archiviata o no.

          Una chat viva non ha e non ha mai avuto un glifo di testa: i marchi
          (Claude / Codex) stanno solo sulle sessioni agente vere, le righe
          terminale, mai su una chat. */}

      {/* THE LEADING-GLYPH COLUMN, RESERVED EVEN THOUGH A CHAT DRAWS NOTHING IN
          IT. Not drawing a glyph on a chat and not reserving its box are two
          different decisions, and only the first one was ever taken: the second
          was inherited. Measured in the live sidebar (card 018fd91f): with a
          project name at 56px, a board / terminal / browser name at 60px and a
          chat name at 34px, one list carried THREE name columns.

          The rule is the one {@link ROW_CHEVRON_SLOT} already applies one
          column to the left, and for the same reason: a column is read down,
          so the air saved on the row that has nothing to show is invisible and
          the broken alignment is not. The chat keeps NO mark of its own, which
          is what the decision above protects; what it gains is the box, empty,
          so every name in the sidebar starts at the same pixel. */}
      <span aria-hidden="true" data-row-glyph-slot="empty" className={ROW_GLYPH_SLOT} />

      {/* Nome + subline. La subline dice SEMPRE qualcosa (vedi TopicSubline):
          lo stato live mentre la sessione è viva, l'ultimo messaggio quando è
          ferma — che è il caso di gran lunga più comune, e prima lasciava la
          riga muta. Sul telefono, dove la sidebar è a tutto schermo, è la
          superficie principale per capire di cosa parla una chat.
          On an attention fill the name goes white (fixes grey-on-blue). */}
      {/* `gap-[3px]` e non `mt-[3px]` sulla subline: le due righe usano
          `truncate-tight`, che si prende il margine verticale per allargare la
          zona di taglio senza alzare la riga — un `mt` sul figlio lo
          sovrascriverebbe e le code tornerebbero tagliate. Il totale resta
          quello di prima: 13 + 3 + 11. */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-[3px]">
        <span data-row-name="chat" className={cn(
          "truncate-tight",
          onFill && cn("font-semibold", ON_FILL_TEXT),
          !onFill && notificationCount > 0 && !isFocused && "font-semibold text-app-text"
        )}>
          {topic.name}
        </span>
        <TopicSubline topicId={topic.id} onFill={onFill} />
      </div>

      {/* Cloud (OpenClaw) attribute — a quiet glyph marking this row as a cloud
          session, not a local one. Muted tone (not the attention axis). */}
      {topic.provider === 'openclaw' && (
        <span className={cn("flex-shrink-0 flex items-center", onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary")} title="Cloud (OpenClaw)" aria-label={tr('topic.cloudSession')}>
          <Cloud size={12} />
        </span>
      )}

      {/* Split position — the same proportional mini-map the tab bar shows,
          this topic's cell lit. Only present when the topic is open in a split
          grid. Rendered BEFORE the spinner/timestamp slot so the streaming
          spinner lands at the row's trailing edge (see below). */}
      {splitPosition && (
        <SplitMiniMap
          rows={splitPosition.rows}
          rowHeights={splitPosition.rowHeights}
          active={splitPosition.active}
          // The map draws from currentColor, so on an attention fill it MUST
          // inherit the fill's high-contrast tone (white on blue / dark on amber)
          // instead of a fixed grey that vanishes on the fill — the grey-on-blue bug.
          className={cn("flex-shrink-0", onFill ? ON_FILL_TEXT_SOFT : "text-app-text-tertiary")}
        />
      )}

      {/* Lo spinner sta FUORI dal binario quieto, ed è l'unica eccezione del
          contratto (vedi ROW_TRAIL in selectionStyles): fermare un turno e
          archiviare la chat sono due azioni diverse nello stesso istante, e
          sbiadire la prima per far posto alla seconda toglierebbe l'unico modo
          di fermare un turno vivo dalla colonna.

          The SAME shared loader the tab bar renders (WaveLoader + hover-stop via
          LoaderSlot), just a bigger 28px box for the sidebar hit target — so the
          sidebar chat row and its tab can't drift in glyph, animation, or stop
          affordance. */}
      {isStreaming && (
        <TopicStreamingSpinner
          topicId={topic.id}
          onStop={onStopStreaming}
          size={28}
          variant="labeled"
          lastActivity={new Date(topic.updatedAt || topic.createdAt).getTime()}
          // La durata del turno la dice già `SessionActivity` sotto al nome. Qui
          // resta il solo campanello dello STALLO — vedi `quiet`.
          quiet
          className="flex-shrink-0"
        />
      )}

      {/* IL BINARIO QUIETO — ora, fissata, finestra, badge. Ordine fisso; un
          nuovo segnale in coda entra QUI, non inventa uno slot (ruling 3.1).
          I glifi ereditano il trattamento su fill via ON_FILL_TEXT_SOFT — mai un
          colore fisso su un fill di attenzione.

          Questi quattro NON si spostano e non spariscono a turno: sbiadiscono
          insieme sotto il comando, che ci passa sopra. Prima il timestamp era
          `group-hover:hidden` DENTRO lo stesso span del comando — quattro
          occupanti per una posizione, e lo slot cambiava larghezza a ogni stato
          (l'inchiostro dell'ora, poi 36, poi 28), cioè il tasto compariva ogni
          volta in una x diversa. */}
      <div className={`${ROW_TRAIL} flex items-center ${ROW_GAP} flex-shrink-0`}>
        {!isStreaming && (
          <RelativeTime
            at={topic.updatedAt}
            className={cn('flex-shrink-0 text-[11px] tabular-nums', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}
          />
        )}
        {pinned && (
          <span
            className={cn('flex-shrink-0 flex items-center', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}
            title="Fissato"
            aria-label="Fissato"
          >
            <Pin size={12} />
          </span>
        )}
        {detachedWindowLabel !== undefined && (
          <span
            className={cn('flex-shrink-0 flex items-center', onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary')}
            title={tr('topic.openElsewhere')}
            aria-label={tr('topic.openElsewhere')}
            // Un segnale che non parla nessuna lingua, per chi deve TROVARE questo
            // glifo. `sidebar.spec.ts` lo cercava per `aria-label`, cioe' su una
            // frase tradotta: quella riga congelava il testo, perche' riscriverlo
            // faceva rosso — e infatti sta nella tabella dei letterali bloccati in
            // tests/e2e/CONVENTIONS.md. L'etichetta resta, ed e' giusto che resti:
            // serve a chi usa uno screen reader. Ma non e' un identificatore.
            data-elsewhere="true"
          >
            <AppWindow size={12} />
          </span>
        )}
        {/* Notification badge — hidden when focused so the user doesn't see a
            count for the topic they're actively looking at. */}
        {!isFocused && <NotificationBadge count={notificationCount} variant={onFill ? 'onFill' : 'default'} />}
      </div>

      {/* IL COMANDO, ULTIMO NEL DOM E SEMPRE ALLA STESSA x.
          ○ vuoto = aperta, un clic archivia (3 s per ripensarci) · ◉ pieno =
          archiviata, un clic ripristina. Niente `Archive` e niente
          `ArchiveRestore`: quei due glifi restano nel MENU, dove accompagnano
          un'etichetta scritta invece di dover dire uno stato da soli.

          `data-pending` tiene acceso il comando mentre il conto scorre: un'azione
          ancora annullabile deve restare annullabile anche se sposti il mouse. */}
      {onArchive && (
        <span
          className={`${ROW_ACTIONS} ${ROW_ACTION_BOX}`}
          data-pending={pendingArchiveStatus ? 'true' : undefined}
        >
          <PendingActionRing
            status={pendingArchiveStatus}
            done={archived}
            size={ROW_ACTION_GLYPH}
            boxClassName={ROW_ACTION_BOX}
            onIdleClick={toggleArchive}
            onDoneClick={toggleArchive}
            idleTitle="Archivia (non chiude la tab)"
            idleAriaLabel={`Archivia ${topic.name}`}
            pendingTitle="Annulla archiviazione"
            pendingAriaLabel={`Annulla archiviazione ${topic.name}`}
            doneTitle="Ripristina"
            doneAriaLabel={`Ripristina ${topic.name}`}
          />
        </span>
      )}
    </div>
  );
});

