import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, BookOpen, ChevronRight, Clock, Cpu, Globe, Kanban, LayoutGrid, MessageSquare, TerminalSquare, UserRound, Wrench, type LucideIcon } from 'lucide-react';
import { getProjectLabel, sidebarItemPaneId, type SidebarItem } from '../../lib/buildSidebarItems';
import type { AttentionTier } from '../../types';
import { attentionSurface, RESTING_SURFACE, ROW_CHEVRON, ROW_CHEVRON_SLOT, ROW_CHEVRON_SLOT_BARE, ROW_GAP, ROW_PX, SELECTED_SURFACE, TAB_LABEL } from '../../lib/selectionStyles';
import { useMobile } from '../../hooks/useMobile';
import { openContextMenuAt } from '../../hooks/useLongPress';
import { useTouchDrag } from '../../hooks/useTouchDrag';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useProjectIcon } from '../Shared/projectIconStore';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { getPaneConfig, getTerminalSessionFromPaneId } from '../../state/pane/adapters/paneConfig';
import { useTerminalAttentionFill, useTopicAttentionFill } from '../../state/signals';
import { rememberDraggedPane } from '../../lib/dragPayload';
import { startDragPreview } from '../../lib/dragPreview';
import { DND_TYPES } from '../../lib/dndTypes';
import { cachedIconPalette, cachedIconTint, fromHex, sampleIconPalette, sampleIconTint } from '../../lib/iconTint';
import { PINNED_ALIGN, PINNED_GRID_CHEVRON_CLASS, PINNED_GRID_CLEAR_CLASS, PINNED_TILE_ACTION_SLOT, PINNED_TILE_H, type PinnedForm } from './pinnedTileMetrics';
import { PinnedLabelMeasure } from './pinnedLabelFit';
import { usePinnedLabelFit } from './usePinnedLabelFit';
import { RowSplitMap } from './RowSplitMap';

/**
 * Il glifo di TIPO, per le cose il cui titolo da solo non basta a
 * riconoscerle: quattro chat si chiamano tutte diversamente ma si somigliano.
 *
 * `project` non c'è, ed è una scelta: la cartella non diceva niente che il nome
 * non dicesse già — un progetto si chiama come la sua cartella — e rubava lo
 * spazio in cui invece serve dire l'unica cosa che il nome NON dice, cioè che
 * quella tessera si apre. Un progetto con una favicon si riconosce da quella;
 * uno senza mostra il nome e basta.
 */
const TYPE_ICONS: Partial<Record<SidebarItem['type'], LucideIcon>> = {
  chat: MessageSquare,
  terminal: TerminalSquare,
  browser: Globe,
  utility: Wrench,
};

/** Le utility non sono un tipo solo: board, statistiche e cron condividono
 *  `type: 'utility'` ma non il glifo. `item.icon` porta il NOME dell'icona da
 *  PANE_CONFIG — la stessa mappa che usano la riga nell'albero e la tab, così
 *  la tessera non può mostrare una chiave inglese al posto della board. */
const UTILITY_ICONS: Record<string, LucideIcon> = {
  Kanban, BarChart3, Activity, BookOpen, Cpu, Clock, UserRound, LayoutGrid,
};

/** Il chevron di apertura — lo stesso delle righe dell'albero, stessa misura e
 *  stessa rotazione, così «si apre» si legge uguale ovunque.
 *
 *  The slot around it (`ROW_CHEVRON_SLOT`) and whether it sits in the flow or
 *  out of it belong to the WRAPPER below: they are decisions of the tile's
 *  form, not of the glyph. */
function ExpandChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      size={ROW_CHEVRON}
      aria-hidden="true"
      data-testid="pinned-expand-hint"
      className={`flex-shrink-0 text-app-text-tertiary transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
    />
  );
}

/** Quanto della tinta si vede sul fondo A RIPOSO.
 *
 *  Molto basso di proposito. La tessera a riposo deve leggersi come una
 *  superficie dell'app appena tinta — un accenno di identità, non un alone: con
 *  otto tessere in griglia otto aloni diventano una macchia sola, e il colore
 *  smette di distinguere proprio quando servirebbe. L'identità forte sta sul
 *  bordo, e il bordo si accende solo da selezionata. */
const TINT_SURFACE = 0.1;

/**
 * Una tessera dei Fissati.
 *
 * ── L'identità è quella che la cosa HA GIÀ ──────────────────────────────────
 * Un progetto che spedisce una favicon si riconosce da QUELLA, e quando la
 * tessera è stretta il titolo se ne va: a 40px di larghezza sarebbe due
 * caratteri e tre puntini, cioè ingombro senza informazione. Appena la tessera
 * è larga abbastanza da tenere una parola (104px, misurati — vedi sotto) il
 * titolo torna, e due progetti con la stessa icona tornano distinguibili. Un
 * progetto senza
 * icona mostra il nome a QUALSIASI larghezza — mai un'iniziale o una tessera
 * generata: «solo icona reale o zero ingombro» è una decisione già presa, e un
 * monogramma è già stato rifiutato una volta. Chat, terminali e browser
 * mostrano glifo di tipo + nome, perché lì il titolo È l'identità: quattro
 * icone-chat identiche non distinguono niente.
 *
 * A decidere è la LARGHEZZA MISURATA, non l'esito di un caricamento: il layout
 * di una tessera non deve dipendere da una richiesta di rete, o si vede il
 * titolo per un frame prima che l'icona arrivi.
 *
 * ── Il bagliore dice CHI SEI, non COSA STAI FACENDO ─────────────────────────
 * La tinta è statica e viene dal colore dominante dell'icona (o dal colore di
 * tipo, che il repo già usa). Non si anima: l'animazione — la corona — è il
 * segnale di «sta lavorando», e due segnali sullo stesso canale sono un segnale
 * che non dice più niente. Se non c'è una sorgente di colore reale non si
 * inventa: la tessera resta neutra.
 *
 * ── Resta una riga, per chi non guarda ──────────────────────────────────────
 * `role="treeitem"` e il nome accessibile ci sono anche quando si vede la sola
 * icona: chi legge con uno screen reader, e i test che cercano la riga per nome,
 * non devono accorgersi che è diventata un quadrato.
 */
export function PinnedTile({
  item,
  expanded,
  focused,
  attention,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onTouchDragStart,
  onTouchDragMove,
  onTouchDragDrop,
  dragging,
  expandable,
  hasActions,
  form = 'grid',
}: {
  item: SidebarItem;
  expanded: boolean;
  focused: boolean;
  /** Il tier che solo il chiamante può sapere: quello ROLLED-UP di un progetto
   *  (`projectAttentionTier` vuole topics, sessioni e visti, che vivono in
   *  TopicTree). Per chat e terminali si risolve qui sotto con gli stessi hook
   *  che usano le righe, così tessera e riga non possono dire cose diverse. */
  attention: AttentionTier | null;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** La tessera si è SOLLEVATA sotto il dito (500ms di pressione). Distinto da
   *  `onDragStart`: lì il fantasma lo disegna il browser, qui non esiste nessun
   *  fantasma e la griglia deve crearselo. */
  onTouchDragStart?: () => void;
  /** Il dito si muove mentre trascina questa tessera, in coordinate viewport.
   *  È il gemello di `dragover` per iOS, dove `dragover` non esiste: la griglia
   *  ci risolve la cella sotto il dito e accende la stessa anteprima. */
  onTouchDragMove?: (x: number, y: number) => void;
  /** Il dito si stacca: la griglia applica lo spostamento. */
  onTouchDragDrop?: (x: number, y: number) => void;
  dragging?: boolean;
  /** C'è qualcosa da aprire qui sotto (le tab di un progetto). Solo allora la
   *  tessera porta il segno che si apre: metterlo su una che non si apre
   *  sarebbe una promessa che il click non mantiene. */
  expandable?: boolean;
  /** Sopra questa tessera si appoggia un comando — il «+» che la griglia
   *  disegna come FRATELLO in `position: absolute` (un bottone dentro un
   *  bottone è HTML non valido). La tessera non lo rende e non lo può misurare:
   *  deve solo sapere che c'è, per lasciargli uno slot invece di finirci sotto
   *  con il nome. Vedi `PINNED_TILE_ACTION_SLOT`. */
  hasActions?: boolean;
  /** THE TILE HAS TWO FORMS, AND ONLY TWO, because the column has two
   *  alignments and not a scale of them.
   *
   *   · `row`  — the tile is alone on its layout row, so it is as wide as the
   *              column: it IS a row, and it lines up like every other row of
   *              the sidebar. Content to the left, starting at the row inset.
   *   · `grid` — the tile shares its row with others: what identifies it (the
   *              icon, the name, or both) sits in the MIDDLE, and everything
   *              that is not identity — chevron, badge — leaves the flow so it
   *              cannot shift that centre.
   *
   *  It is told by the grid, not measured from the width: "am I alone on my
   *  row" is a fact of the layout, and a width threshold answered it wrong at
   *  every sidebar size but one — three tiles in a 400px column are 130px each,
   *  which used to read as "row form" and left them all left-aligned. */
  form?: PinnedForm;
}) {
  const projectPath = item.type === 'project' ? (item.projectPath ?? '') : '';
  const icon = useProjectIcon(projectPath);
  const hasRealIcon = icon.status === 'has';
  /** L'icona di un progetto è ancora in volo — vero solo al PRIMO incontro con
   *  quel progetto: dal secondo in poi lo store risponde 'has' già al primo
   *  render, dalla cache persistita. */
  const iconProbing = item.type === 'project' && icon.status === 'probing';

  // Tinta: dall'icona per i progetti, dal colore di tipo per tutto il resto.
  // Nessun ripiego per un progetto senza icona — quello resta neutro.
  // `utility` non è un tipo di pane e non ha un colore in `PANE_CONFIG`: resta
  // senza tinta, come i progetti senza icona. Nessun colore inventato per
  // riempire il buco.
  const typeTint = item.type === 'chat' || item.type === 'terminal' || item.type === 'browser'
    ? getPaneConfig(item.type).color
    : undefined;
  // L'esito è tenuto INSIEME alla sorgente da cui viene, e la tinta si DERIVA
  // confrontando le due: così cambiare icona non ha bisogno di un setState di
  // azzeramento nell'effetto (che sarebbe un render a cascata), e una tinta
  // vecchia non può mai comparire su un'icona nuova.
  const [sampled, setSampled] = useState<{ src: string; tint: string | null } | null>(
    () => {
      const known = icon.src ? cachedIconTint(icon.src) : undefined;
      return icon.src && known !== undefined ? { src: icon.src, tint: known } : null;
    },
  );
  useEffect(() => {
    const src = icon.src;
    if (!src) return;
    let alive = true;
    void sampleIconTint(src).then(tint => { if (alive) setSampled({ src, tint }); });
    return () => { alive = false; };
  }, [icon.src]);
  const iconTint = icon.src !== null && sampled !== null && sampled.src === icon.src ? sampled.tint : null;
  const tint = iconTint ?? typeTint ?? null;

  // La PALETTE per settori: serve alla cornice, che non porta una tinta sola ma
  // i colori dell'icona DOVE stanno (verde in alto, blu in basso, come nel logo).
  const [palette, setPalette] = useState<{ src: string; colors: string[] | null } | null>(() => {
    const known = icon.src ? cachedIconPalette(icon.src) : undefined;
    return icon.src && known !== undefined ? { src: icon.src, colors: known } : null;
  });
  useEffect(() => {
    const src = icon.src;
    if (!src) return;
    let alive = true;
    void sampleIconPalette(src).then(colors => { if (alive) setPalette({ src, colors }); });
    return () => { alive = false; };
  }, [icon.src]);
  const sectorColors = icon.src !== null && palette !== null && palette.src === icon.src ? palette.colors : null;

  // ── La luce PROIETTATA, non spalmata ────────────────────────────────────
  //
  // Un `conic-gradient` GIRA: i colori si susseguono lungo l'anello a raggio
  // costante, e il risultato è una fascia arcobaleno — colorata, ma non
  // «illuminata da quella cosa lì». In Dia ogni colore del logo è una luce
  // ACCESA DIETRO, che si allarga verso il bordo dalla direzione in cui quel
  // colore sta: il blu in basso sfonda in basso, il verde in alto a sinistra
  // sfonda in alto a sinistra.
  //
  // Quindi: un radial-gradient per spicchio, centrato nella DIREZIONE dello
  // spicchio e spinto fino al bordo. Il fondo di ogni luce è lo stesso colore ad
  // alpha 0 (non `transparent`, che interpola passando per il nero e lascia un
  // alone sporco fra una luce e l'altra).
  const projection = useMemo(() => {
    const stops = sectorColors ?? (tint ? [tint] : null);
    if (!stops || stops.length === 0) return null;
    const n = stops.length;
    return stops
      .map((hex, i) => {
        const c = fromHex(hex);
        if (!c) return null;
        // Centro dello spicchio, da ore 12 in senso orario. Con una tinta sola
        // la luce sta al centro e si allarga in tondo.
        const rad = n === 1 ? 0 : ((i + 0.5) / n) * Math.PI * 2;
        const x = n === 1 ? 50 : 50 + 50 * Math.sin(rad);
        const y = n === 1 ? 50 : 50 - 50 * Math.cos(rad);
        const rgb = `${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}`;
        return `radial-gradient(65% 65% at ${x.toFixed(1)}% ${y.toFixed(1)}%, rgb(${rgb} / 1) 0%, rgb(${rgb} / 0) 72%)`;
      })
      .filter(Boolean)
      .join(', ');
  }, [sectorColors, tint]);

  /**
   * QUANTO è accesa la cornice — e «accesa» vuol dire UNA cosa: sei qui.
   *
   * Era `focused || expanded`, cioè due stati diversi dipinti con lo stesso
   * segnale al massimo. Il fuoco non può essere doppio (lo decide un confronto
   * fra stringhe, uno solo vince), ma `expanded` è un INSIEME: apri la fascia
   * di un progetto, poi porti il fuoco su un'altra tessera, e la prima torna a
   * riposo nella superficie — che legge solo `focused` — mentre la CORNICE
   * resta piena, perché la sua fascia è ancora aperta. Due tessere con lo
   * stesso bordo pieno e una sola col fuoco: è il «cambio fuoco fra le pin e a
   * volte resta illuminato il bordo», e il «a volte» sono proprio le tessere
   * che si aprono, cioè i progetti con tab.
   *
   * Aperta-ma-non-a-fuoco resta comunque una cosa che vale la pena dire, e la
   * si dice un GRADINO più in basso: la stessa cornice, smorzata. Che sia
   * aperta lo dicono già il chevron ruotato e la fascia visibile sotto — questa
   * è la conferma sul bordo, non un secondo «sei qui».
   */
  const rimLit = focused ? 'opacity-100' : expanded ? 'opacity-40' : 'opacity-0';

  // Gli stessi segnali delle righe, dagli stessi hook: una tessera non può
  // dire «tutto calmo» mentre la riga della stessa cosa è accesa.
  const topicTier = useTopicAttentionFill(item.type === 'chat' ? item.id : undefined);
  const termTier = useTerminalAttentionFill(
    item.type === 'terminal' ? getTerminalSessionFromPaneId(item.id) ?? undefined : undefined,
  );
  const tier = attention ?? topicTier ?? termTier;

  const Glyph = (item.type === 'utility' ? UTILITY_ICONS[item.icon] : undefined) ?? TYPE_ICONS[item.type];

  const surface = useMemo(() => {
    // Precedenza invariata rispetto alle righe: attenzione batte selezione,
    // selezione batte riposo. La tinta d'identità vive SOTTO, come alone, così
    // non compete mai con il segnale di stato.
    //
    // Il riposo è `RESTING_SURFACE`, non una copia: qui c'era la stessa scala
    // riscritta a mano, e aveva GIÀ deviato di 0.01 sull'hover in tema scuro
    // (0.07 contro 0.08). Una tessera e un bottone della stessa famiglia si
    // accendevano di un soffio diverso sotto lo stesso dito — invisibile da
    // soli, visibile affiancati, che è come la sidebar si guarda.
    if (tier) return attentionSurface(tier);
    if (focused) return SELECTED_SURFACE;
    return RESTING_SURFACE;
  }, [tier, focused]);

  // COL DITO IL GESTO È UNO SOLO, e fa due cose: tieni premuto e RILASCI → il
  // menu (lo stesso del tasto destro); tieni premuto e MUOVI → la trascini.
  //
  // Il secondo mezzo non c'era, e non per dimenticanza: su iOS il drag and drop
  // di HTML5 non esiste, quindi `draggable` + `dragstart` — la sola strada che
  // questa griglia aveva per riordinare — è inerte su un telefono. Vedi
  // `useTouchDrag`, che porta anche il perché dei listener nativi.
  //
  // COL DITO L'ANTEPRIMA NON LA COSTRUISCE QUESTA TESSERA, e non è una
  // dimenticanza: la griglia che la ospita ne disegna già una, ed è la tessera
  // VERA (`PinnedTilePreview` in un portale, marcata `data-drag-preview` come
  // vuole il contratto). Chiamare qui `startTouchDragPreview` ne farebbe una
  // seconda sotto lo stesso dito, che è esattamente il «si vede doppio» contro
  // cui `lib/dragPreview` mette in guardia.
  const { isTouch } = useMobile();
  const press = useTouchDrag({
    enabled: isTouch && (!!onContextMenu || !!onTouchDragMove),
    onPress: onContextMenu ? openContextMenuAt : undefined,
    onLift: onTouchDragStart,
    onMove: onTouchDragMove,
    onDrop: onTouchDragDrop,
    onCancel: onDragEnd,
  });

  /** Alone on its row = a row; sharing it = a tile in a grid. See `form`. */
  const isRow = form === 'row';
  /** The alignment is not decided here: it is READ from the form, in the one
   *  place that declares both (see `PINNED_ALIGN`). */
  const align = PINNED_ALIGN[form];

  /** Something is drawn in front of the name: a favicon or a type glyph. */
  const hasIdentityIcon = hasRealIcon || !!Glyph;

  // DOES THE NAME FIT? Measured from the DOM, never from the icon's loading
  // state: the two widths, the observer and the first-paint timing live in
  // `pinnedLabelFit`, next to the box they read the name from.
  const { tileRef, measureRef, labelShown } = usePinnedLabelFit({
    isRow, name: item.name, hasIcon: hasIdentityIcon, expandable: !!expandable,
  });

  return (
    <button
      ref={tileRef}
      type="button"
      role="treeitem"
      aria-label={item.name}
      aria-selected={focused}
      aria-expanded={expanded}
      data-pinned="true"
      data-pinned-tile={item.id}
      data-testid="pinned-tile"
      title={item.name}
      draggable={!isTouch}
      onDragStart={e => {
        // DUE tipi sullo stesso dataTransfer, di proposito: `PINNED_TILE` per la
        // griglia dei fissati (riordino), `PANEL_ID` per la griglia dei pane
        // (apri la cosa dove l'hai lasciata cadere). Chi riceve prende il tipo
        // che capisce, e trascinare un fissato dentro la griglia continua a
        // funzionare come prima che questa griglia esistesse.
        // `PINNED_TILE` porta la chiave della RIGA (quella del layout), che è
        // ciò che serve per riordinare dentro la griglia dei fissati.
        e.dataTransfer.setData(DND_TYPES.PINNED_TILE, item.id);
        // `PANEL_ID` porta la chiave della PANE, che per un progetto è un'altra
        // stringa: chi lo riceve apre o sposta una pane, e con l'id della riga
        // il drop cadrebbe su una pane che non esiste — senza un errore.
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, sidebarItemPaneId(item));
        rememberDraggedPane(sidebarItemPaneId(item));
        e.dataTransfer.effectAllowed = 'move';
        // Qui non c'era nessuna `setDragImage`, quindi il fantasma lo sceglieva
        // macOS: l'icona generica di documento. La tessera è QUADRATA e spesso
        // mostra la sola icona, quindi il nome è proprio la cosa che sparisce
        // dallo schermo nel momento in cui la si prende in mano.
        startDragPreview(e, {
          title: item.name,
          // Per una tessera di PROGETTO il nome è già il nome della cartella:
          // sotto va il percorso intero, che è l'unica cosa che distingue due
          // progetti chiamati uguale.
          subtitle: item.type === 'project'
            ? item.projectPath
            : item.projectPath ? getProjectLabel(item.projectPath) : undefined,
          badges: item.notificationCount > 0 ? [String(item.notificationCount)] : [],
        });
        onDragStart?.();
      }}
      onDragEnd={() => onDragEnd?.()}
      {...press.handlers}
      data-pressing={press.pressed || undefined}
      data-touch-dragging={press.dragging || undefined}
      onClick={() => { if (press.consumeClick()) return; onToggle(); }}
      onContextMenu={onContextMenu}
      className={[
        // `ROW_GAP` e non `gap-1`: l'aria fra il glifo e il nome era 4 qui e 8
        // su ogni riga della colonna, cioè nella STESSA colonna il nome di una
        // tessera partiva quattro pixel prima di quello della riga sotto. È lo
        // stesso difetto che il commento su `ROW_PX` qui sotto racconta per
        // l'incasso, corretto a metà: allora era stato allineato il padding e
        // lasciato indietro il gap.
        `group/tile relative flex items-center ${ROW_GAP}`,
        // ONE ALIGNMENT PER FORM, decided by `form` and by nothing else.
        // It used to be a scale of container-query thresholds — 54, 72, 104,
        // 200 — and between two of them the tile centred its NAME inside a box
        // that was itself left-aligned: a third alignment nobody asked for.
        // In grid form what is left in the flow is only the identity (icon,
        // name), so centring it centres what you see.
        align.justify,
        // `ROW_PX`, non un `px-1.5` scritto a mano: quel file dichiara questo
        // valore come «l'incasso orizzontale canonico di una riga di
        // contenuto — una tab della barra E una riga della colonna — così che
        // il rientro si legga identico sulle due superfici». La tessera è la
        // terza faccia della stessa cosa e stava a 6 contro i loro 8: misurato
        // a 390×844, nome della tessera e nome della riga partivano da due
        // colonne diverse nella stessa colonna.
        `${PINNED_TILE_H} w-full min-w-0 rounded-lg ${ROW_PX} select-none`,
        // IN GRID FORM, WHILE THE ACCORDION IS DRAWN, THE CONTENT KEEPS CLEAR
        // OF IT: the chevron is out of the flow at the left edge, and a name
        // that is the tile's only identity (no favicon) would otherwise run
        // under it. Symmetric, so the centre stays the centre (see
        // PINNED_GRID_CLEAR_CLASS).
        expandable && !isRow ? PINNED_GRID_CLEAR_CLASS : '',
        'transition-colors duration-100',
        // Il filo neutro resta SEMPRE: la cornice accesa gli si sovrappone da
        // selezionata, e a riposo la tessera torna sobria come una qualsiasi.
        //
        // Era `ring-1 ring-inset ring-black/5` — un filo PIATTO, uguale sui
        // quattro lati. `edge-lit` (index.css) è lo stesso filo più il riflesso
        // sullo spigolo alto: la tessera smette di essere un rettangolo colorato
        // e diventa una superficie che sta un gradino sopra il fondo. È lo
        // stesso trattamento delle tab e del «+», quindi le tre famiglie di
        // card della sidebar si leggono come una sola.
        'edge-lit',
        surface,
        dragging ? 'opacity-40' : '',
      ].join(' ')}
      style={tint ? ({ '--tile-tint': tint } as React.CSSProperties) : undefined}
    >
      {/* LA LUCE DELL'ICONA, SUL BORDO E DENTRO IL BORDO.
          Ogni colore del logo è una luce accesa dietro, che si allarga verso il
          bordo dalla direzione in cui quel colore sta — il blu in basso sfonda
          in basso, il verde in alto a sinistra sfonda lì. Un gradiente conico
          invece GIRA, e quello che esce è una fascia arcobaleno: colorata, non
          illuminata da quella cosa lì.

          NIENTE ESCE DALLA TESSERA. Qui c'era un secondo strato sfocato a
          `-inset-1.5` con `blur(9px)`: ~15px di alone dipinti FUORI dal
          rettangolo, che sconfinavano sulle tessere vicine e sulla riga sotto —
          in una griglia fitta la luce di una tessera finiva addosso a un'altra,
          e non si capiva più quale delle due fosse accesa. La cornice resta, il
          bagliore no: `inset-0`, cioè esattamente sul bordo, non un pixel oltre.

          Piena SOLO da selezionata, smorzata su una tessera aperta che il fuoco
          ha lasciato (vedi `rimLit`). Statica: l'animazione è il segnale di «sta
          lavorando», e due segnali sullo stesso canale non ne fanno uno più
          forte, ne fanno uno muto.

          E LA CORNICE C'È SEMPRE, colore o non colore. Prima esisteva solo se
          c'era una luce da proiettare: una tessera senza icona e senza colore di
          tipo — un progetto senza favicon, una utility — da selezionata restava
          senza bordo, cioè si accendeva in un modo diverso da tutte le altre.
          «Senza colore» deve voler dire un colore diverso, non una FORMA diversa:
          stessa geometria, stesso raggio, stessa dissolvenza, e al posto della
          proiezione il neutro della famiglia (la stessa scala in alpha di
          `SELECTED_SURFACE`, un gradino più su perché un filo sottile ha bisogno
          di più contrasto di una campitura). */}
      <span
        aria-hidden="true"
        data-testid="pinned-tile-rim"
        data-rim={projection ? 'tinta' : 'neutro'}
        // Sta sopra il riflesso di `edge-lit` senza doverlo dichiarare: un
        // `::before` è il PRIMO figlio dell'albero di scatole, quindi fra due
        // elementi posizionati senza z-index vince questo, che viene dopo. La
        // cornice accesa copre il filo neutro, che è l'ordine giusto.
        className={`pointer-events-none absolute inset-0 rounded-lg transition-opacity duration-200 ${rimLit} ${
          projection ? '' : 'bg-black/[0.18] dark:bg-white/[0.22]'
        }`}
        style={{
          ...(projection ? { background: projection } : null),
          padding: 1.5,
          // La maschera tiene solo la cornice: `exclude` e' lo standard,
          // `xor` il nome che WebKit conosce da prima. Servono entrambi.
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          maskComposite: 'exclude',
        }}
      />


      {/* L'alone d'identita' sul FONDO. Sta sotto il contenuto e sopra la
          superficie di stato, a bassa opacita': una tinta, non una vernice. */}
      {tint && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            background:
              `radial-gradient(100% 78% at 50% 118%, color-mix(in oklab, var(--tile-tint) ${Math.round(TINT_SURFACE * 100)}%, transparent) 0%, transparent 70%)`,
          }}
        />
      )}

      {/* IN RIGA, non impilati.
          A 32px lo stack verticale NON CI STA: glifo (16) + nome su due righe
          (25) chiedono 38px, e il browser taglia — misurato, ed era il motivo
          per cui l'anteprima «non si vedeva» pur essendoci. In orizzontale
          l'altezza richiesta è quella dell'elemento più alto, cioè l'icona, e
          il nome si prende tutta la larghezza che resta.

          «Senza ripetere il titolo se non c'entra» voleva dire proprio questo:
          se non ci sta. In una riga larga ci sta, troncato, e allora c'è — la
          soglia la misura la container query qui sotto. */}
      {/* THE ACCORDION, AND ONLY WHERE THERE IS ONE TO OPEN.
          The slot is the shared one (`ROW_CHEVRON_SLOT`): box = glyph, so the
          ink starts at the row inset and lands in the same column as the
          chevron of a project row and of a chat row with children.

          IN ROW FORM IT IS ALWAYS RESERVED, empty when there is nothing to
          open: a row is read in a column, and 20px of saved air on one row is
          the misalignment of the whole list (see ROW_CHEVRON_SLOT). In GRID
          form nothing is reserved, because there the tile is not read in a
          column: it is centred, and an empty box on the leading side is exactly
          what pushes the identity off centre.

          IN GRID FORM IT IS MIRRORED, NOT REMOVED. Its weight would push the
          identity off centre by half a chevron plus half a gap — measured on a
          77px tile, 28px of air on the left against 8 on the right. Taking it
          out of the flow fixes the centre and creates a worse problem: out of
          the flow it stops reserving its room, and the name runs underneath
          it. So the same 12px come back on the OTHER side, empty (see the
          mirror at the end): the trigger does not weigh on the centre because
          it weighs the same on both sides. Asked in these words: "we could
          mirror the trigger's weight on the right, so spacing, footprint and
          alignment stay correct". */}
      {/* AND THE SAME FOR THE "+", which lands on the trailing corner: in grid
          form its slot is mirrored in FRONT, so what is centred stays centred
          while the command has its room. At rest both collapse (the shrink
          factors below), so a name that fits sees neither. */}
      {hasActions && !isRow && (
        <span
          aria-hidden="true"
          data-testid="pinned-tile-action-mirror"
          className={`hidden shrink-[9999] group-hover/cell:shrink-0 @min-[104px]/tile:block ${PINNED_TILE_ACTION_SLOT}`}
        />
      )}

      {expandable ? (
        <span
          data-testid="pinned-chevron-slot"
          // IN GRID FORM THE ACCORDION LEAVES THE FLOW AND STAYS AT THE LEFT
          // EDGE (card 058ea722, 03/09: "when the icon is centred the
          // accordion must stay on the left, where it would be if nothing
          // were centred"). It used to sit in the flow next to the icon with
          // an empty mirror box on the other side: the centre came out right
          // and the chevron travelled to the middle of the tile with it. Out
          // of the flow it marks the row's edge like every other accordion of
          // the column, and it weighs nothing on the centre by construction.
          // The bare box (no ROW_LEAD_TIGHTEN): out of the flow there is no
          // gutter to close.
          // What keeps the identity CLEAR of it is `pinnedLabelShown`: the
          // name is drawn only if it fits with the chevron zone kept free on
          // both sides, and the icon alone is centred, which lands it right
          // of the chevron at every width where the chevron is drawn.
          className={`${isRow ? ROW_CHEVRON_SLOT : `${ROW_CHEVRON_SLOT_BARE} ${PINNED_GRID_CHEVRON_CLASS}`} ${
            // UNDER 76px THE HINT DOES NOT FIT, and this is the sum, not a
            // taste: 8 + 12 + 8 of chevron zone on each side + 18 of icon =
            // 74. Below that the centred icon would land on the chevron. What
            // goes is the HINT, not the behaviour: the tile still opens on
            // click, and the identity keeps the middle. The same number is
            // `PINNED_GRID_PX.chevronMin`, which the fit rule reads.
            isRow ? '' : 'hidden @min-[76px]/tile:flex'
          }`}
        >
          <ExpandChevron expanded={expanded} />
        </span>
      ) : align.reservesChevron ? (
        // IN ROW FORM THE COLUMN COMES FIRST. A pinned row that does not open
        // reserves the accordion box anyway, or its icon would start 20px
        // (slot + gap) left of the icon of the row above it - the same two
        // alignments the tree had. In GRID form nothing is reserved: there the
        // tile is centred and the trigger's weight is mirrored on the other
        // side (see above), so an empty box would push the identity off centre.
        <span aria-hidden="true" data-row-chevron-slot="empty" className={ROW_CHEVRON_SLOT} />
      ) : null}

      {/* IL CONTENITORE DELL'ICONA SPARISCE QUANDO NON C'E' UN'ICONA.
          Un riquadro largo ZERO non occupa spazio, ma il `gap-2` della riga
          SI': lo spazio si mette fra due figli, e un figlio vuoto e' comunque
          un figlio. Misurato su una tessera stretta senza icona: 16px di aria
          a sinistra contro 8 a destra, cioe' il nome fuori centro di 4 - lo
          stesso difetto dello slot del chevron, un elemento piu' in la'.
          `hidden` e non `w-0`: toglie il figlio dal flusso, e con lui il suo
          gap. Il segnaposto mentre la sonda gira resta, perche' li' un
          ingombro c'e' e serve (tiene il posto che l'icona avra'). */}
      {/* IN ROW FORM TOO THE BOX EXISTS ONLY WITH SOMETHING IN IT. It used to
          be kept empty so that a project without a favicon started its name
          in the same column as one with a favicon (measured on 17/08: chat at
          x=50, project without favicon at x=28, with favicon at x=54). On
          03/09 (card 058ea722) the owner reversed that trade for the whole
          sidebar: the name sits at the minimum distance and moves right only
          when there IS an icon (see `rowLeadGlyph.ts`). The probe placeholder
          stays, for the one round trip in which the answer is in flight. */}
      <span className={`relative ${
        // THE BOX COMES FROM THE FORM, and in row form it is the column's own
        // slot: sized on the glyph the tile's ink started 2px before the ink of
        // the row above it, because the column reserves 18px for every glyph
        // and the tile reserved 14 (measured by tests/e2e/sidebar-pinned-alignment).
        isRow ? PINNED_ALIGN.row.iconSlot : PINNED_ALIGN.grid.iconSlot
      } ${hasIdentityIcon || iconProbing ? 'flex' : 'hidden'}`}>
        {hasRealIcon
          ? <ProjectFavicon path={projectPath} size={18} />
          : Glyph
            ? <Glyph size={14} className="text-app-text-secondary" aria-hidden="true" />
            // Un progetto la cui icona è ancora in volo tiene il POSTO che
            // l'icona avrà: senza, quando arriva il nome scivola via di 18px a
            // cose ferme. Solo mentre sonda — un progetto che risulta senza
            // icona torna a zero ingombro, che è la decisione già presa.
            : <span aria-hidden="true" className="block w-[18px]" />}
      </span>

      {/* THE MEASURING BOX (see `pinnedLabelFit`): the whole name in a box of
          no size, only in grid form, where the question is asked. */}
      {!isRow && <PinnedLabelMeasure measureRef={measureRef} name={item.name} />}

      {/* THE NAME LEAVES ONLY WHEN THERE IS ANOTHER IDENTITY TO READ.
          Below the threshold the tile is too narrow for the title to say
          anything: it would be one letter and an ellipsis. With a favicon
          holding the identity the name goes and the icon stays, centred; with
          no icon the name stays at ANY width, because there it is the only
          identity the tile has and four identical chat glyphs distinguish
          nothing. 11px is the app's floor of legibility: we do not go under it
          to fit one more word.

          It is a CONTAINER QUERY on the cell and not a boolean: the width of a
          tile depends on how many are in the row and on how wide the sidebar
          is, that is, on things that change while you drag. Measured from CSS
          it answers during the gesture and — above all — it does not go
          through any asynchronous state: it was exactly the dependency on the
          icon that made the title flash at every refresh.

          THE THRESHOLD IS 104, and it is measured. Between icon, insets,
          count and the command slot the tile eats 74px before it gets to the
          name; 74 + 30 (five characters at 11px) = 104. The number is written
          out in the class because Tailwind reads the source: a variable here
          would generate no rule.

          IT SIZES ITSELF TO THE TEXT, it does not stretch. `flex-1` in grid
          form made the name box eat all the free width and then centre the
          text INSIDE that box: measured on a 77px tile, the text sat 11px
          right of the tile's centre — the group looked centred to the code and
          was not on the screen. Shrink-to-fit (`flex-initial` + `max-w-full`)
          leaves the free space where `justify-center` can split it in two.
          In row form the name still takes everything that is left, because
          there the tile is a row and the trailing slot needs a name that
          yields. */}
      <span
        data-testid="pinned-tile-name"
        // MARKED AS A NAME OF THE COLUMN ONLY IN ROW FORM, because only there
        // is it read in the column: `sidebar-name-column.spec.ts` demands ONE x
        // for every `data-row-name` of the same depth, and a grid tile centres
        // its identity on purpose. Marking it in both forms would ask the
        // measurement to condemn a decision taken on the board (27/08).
        data-row-name={isRow ? 'pinned' : undefined}
        className={`relative min-w-0 max-w-full truncate-tight ${TAB_LABEL} ${
          isRow
            // `flex-auto` and not `flex-1`: with basis 0 the name takes all the
            // room LEFT OVER by the trailing slot, so it truncates even while
            // the "+" is not there. With its basis on the content (capped by
            // the tile) the name declares what it needs and the one that gives
            // way is the slot. See the slot at the bottom for the other half.
            ? 'flex-auto text-left'
            // AND IT LEAVES THE FLOW WHEN THERE IS NO FLOW LEFT, icon or not.
            // Without a favicon the name used to stay at ANY width, because
            // there it is the only identity the tile has. True down to the
            // width where the name box is squeezed to ZERO: from there on it
            // shows nothing and still costs its gap, and glyph plus gap no
            // longer fit, so what you see is a glyph pushed 4px off centre
            // (measured: 5 tiles in a 190px sidebar, air 4.3 left against 12.3
            // right). 52 is the sum: 16 of inset + 14 of glyph + 8 of gap = 38
            // before the first character, plus 14 for that character to exist.
            // THE NAME IS DRAWN ONLY IF IT FITS WHOLE (card 058ea722, 03/09:
            // three tiles reading "to...", "ar...", "ed..."). The verdict is
            // measured (`labelShown`, from `pinnedLabelShown`); until the
            // first measurement the container-query thresholds of before
            // stand in, so nothing depends on an asynchronous answer.
            : `flex-initial text-center ${
              labelShown === null
                ? (hasIdentityIcon ? 'hidden @min-[104px]/tile:block' : 'hidden @min-[52px]/tile:block')
                : labelShown ? 'block' : 'hidden'
            }`
        }`}
      >
        {item.name}
      </span>

      {item.notificationCount > 0 && (
        // IN ROW FORM IT IS IN LINE, IN GRID FORM IT LEAVES THE FLOW.
        // In the middle of a row the count is one more thing on the line, and
        // it belongs there. In a grid it would steal width from the identity
        // and push it off axis, so it climbs into the corner like the badge of
        // an icon: what is not identity does not weigh on the centre. It used
        // used to be gated by a container query at 72px, which is the same
        // rule written as a width instead of as a form.
        // It disappears under the pointer because the "+" lands in that very
        // spot, and two things on top of each other do not read.
        <NotificationBadge
          count={item.notificationCount}
          className={`flex-shrink-0 group-hover/cell:invisible ${
            isRow ? 'relative' : 'pinned-tile-count'
          }`}
        />
      )}

      {/* LO SLOT DEL «+» — spazio VUOTO, e per una volta è il punto.
          Il comando non è mai stato in fila con questo contenuto: la griglia lo
          disegna come fratello assoluto sopra la tessera (un bottone dentro un
          bottone è HTML non valido), quindi il nome — `flex-1 truncate` —
          arrivava fino a 6px dal bordo e il bottone gli atterrava SOPRA. Sotto
          la vibrancy, dove il suo fondo è un'alpha, il testo ci si leggeva
          attraverso: metà del «tastino troppo stretto» era questo, non una
          larghezza sbagliata.

          C'È SEMPRE ma CEDE finché il «+» non si vede davvero. Riservarlo e
          basta tagliava il nome ventiquattro ore su ventiquattro per un
          bottone che compare solo al passaggio del mouse: «non dovremmo
          tagliare il testo finché non mostriamo effettivamente il +»
          (Attilio, 13/08). Farlo NASCERE all'hover era l'altro estremo, e
          faceva saltare il nome ogni volta che ci passavi accanto.

          La via di mezzo è tutta nei fattori di contrazione. A riposo lo slot
          si stringe per primo (`shrink-[9999]` contro l'1 del nome): se il
          nome ci sta, lo slot resta largo e non cambia niente rispetto a
          prima; se non ci sta, lo slot si chiude e il nome arriva al bordo.
          All'hover torna rigido (`shrink-0`), così il bottone che sta per
          apparire trova il suo posto. Chi si muove è quindi solo un nome
          troppo lungo, e solo nell'istante in cui il «+» arriva a coprirlo.

          E solo in forma RIGA — sotto la soglia la tessera è larga quanto il
          bottone, e lì lo slot sarebbe tutto lo spazio che c'è.

          Sta DOPO il badge di proposito: il conteggio resta al suo posto e lo
          slot si apre oltre, così le due cose non si contendono lo stesso
          angolo. */}
      {/* WHERE THIS PANE SITS IN THE SPLIT — the same schematic every sidebar
          row carries, and in row form the tile IS a row (see `splitMap` in
          PINNED_ALIGN for why a grid tile does not get it). Before the trailing
          slot, like the sisters: it is a signal of POSITION, and the command
          that appears on hover lands beyond it. */}
      {align.splitMap && <RowSplitMap paneId={sidebarItemPaneId(item)} />}

      {hasActions && (
        <span
          aria-hidden="true"
          data-testid="pinned-tile-action-slot"
          className={`shrink-[9999] group-hover/cell:shrink-0 ${PINNED_TILE_ACTION_SLOT} ${
            // In row form there is always room for it; in grid form only above
            // the width where a word fits at all — under it the slot would BE
            // the tile.
            isRow ? 'block' : 'hidden @min-[104px]/tile:block'
          }`}
        />
      )}
    </button>
  );
}
