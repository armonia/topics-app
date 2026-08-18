import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, BookOpen, ChevronRight, Clock, Cpu, Globe, Kanban, LayoutGrid, MessageSquare, TerminalSquare, UserRound, Wrench, type LucideIcon } from 'lucide-react';
import { sidebarItemPaneId, type SidebarItem } from '../../lib/buildSidebarItems';
import type { AttentionTier } from '../../types';
import { attentionSurface, RESTING_SURFACE, ROW_GAP, ROW_PX, SELECTED_SURFACE, TAB_LABEL } from '../../lib/selectionStyles';
import { useMobile } from '../../hooks/useMobile';
import { openContextMenuAt } from '../../hooks/useLongPress';
import { useTouchDrag } from '../../hooks/useTouchDrag';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useProjectIcon } from '../Shared/projectIconStore';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { getPaneConfig, getTerminalSessionFromPaneId } from '../../state/pane/adapters/paneConfig';
import { useTerminalAttentionFill, useTopicAttentionFill } from '../../state/signals';
import { rememberDraggedPane } from '../../lib/dragPayload';
import { DND_TYPES } from '../../lib/dndTypes';
import { cachedIconPalette, cachedIconTint, fromHex, sampleIconPalette, sampleIconTint } from '../../lib/iconTint';
import { PINNED_TILE_ACTION_SLOT, PINNED_TILE_H } from './pinnedTileMetrics';

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
 *  Lo SLOT (larghezza fissa) e l'uscita dal flusso sulle tessere quadrate
 *  (`pinned-tile-lead`) stanno sul wrapper, non qui: sono decisioni di LAYOUT
 *  della riga, e tenerle sul glifo faceva sì che il nome partisse da una x
 *  diversa a seconda che la tessera fosse espandibile o no. */
function ExpandChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      size={12}
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
  const { isTouch } = useMobile();
  const press = useTouchDrag({
    enabled: isTouch && (!!onContextMenu || !!onTouchDragMove),
    onPress: onContextMenu ? openContextMenuAt : undefined,
    onLift: onTouchDragStart,
    onMove: onTouchDragMove,
    onDrop: onTouchDragDrop,
    onCancel: onDragEnd,
  });

  return (
    <button
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
        // Con il nome accanto non c'è spazio libero da distribuire (il nome è
        // `flex-1`), quindi questo si vede SOLO quando il nome se n'è andato:
        // l'icona rimasta sola sta al centro, e sopra la soglia la tessera
        // torna una riga, che comincia da sinistra.
        // Centra ciò che è NEL FLUSSO: perché il centro sia quello dell'icona
        // e non quello del gruppo, chevron e conteggio ne escono — vedi
        // `pinned-tile-lead` / `pinned-tile-count` in `index.css`.
        'justify-center @min-[104px]/tile:justify-start',
        // `ROW_PX`, non un `px-1.5` scritto a mano: quel file dichiara questo
        // valore come «l'incasso orizzontale canonico di una riga di
        // contenuto — una tab della barra E una riga della colonna — così che
        // il rientro si legga identico sulle due superfici». La tessera è la
        // terza faccia della stessa cosa e stava a 6 contro i loro 8: misurato
        // a 390×844, nome della tessera e nome della riga partivano da due
        // colonne diverse nella stessa colonna.
        `${PINNED_TILE_H} w-full min-w-0 rounded-lg ${ROW_PX} select-none`,
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
      {/* IL CHEVRON NON SPOSTA IL NOME.
          Misurato nel DOM sulle tessere vere: quelle con il chevron avevano il
          testo a x=42, tutte le altre a x=36. Sei pixel su una colonna di righe
          identiche, cioè il tipo di scarto che si vede senza riuscire a
          nominarlo - segnalato come «assicuriamoci che le icone degli accordion
          siano tutte correttamente allineate».
          Larghezza FISSA anche da vuoto: se lo spazio comparisse solo per le
          tessere espandibili, il nome ballerebbe fra una riga e l'altra, che è
          lo stesso difetto al contrario. */}
      {/* MA UNO SLOT VUOTO NON DEVE PESARE DOVE IL CONTENUTO È CENTRATO.
          Sotto i 104px il contenitore passa a `justify-center`: lì non c'è più
          una colonna da cui far partire i nomi, c'è un centro. Uno slot vuoto
          di 12px più 8 di gap continuava a spingere tutto a destra — misurato
          su una tessera larga 77: 28px di aria a sinistra contro 8 a destra,
          il contenuto fuori centro di 10px. Segnalato: «quelle pinnate, icona
          o testo, devono essere ben centrate e il trigger non dovrebbe
          partecipare al peso per farlo centrato».
          Sparisce solo da VUOTO: con un chevron dentro resta, e a centrarsi è
          il gruppo intero — che è ciò che si vede. */}
      <span
        data-testid="pinned-chevron-slot"
        aria-hidden={!expandable || undefined}
        className={`w-3 flex-shrink-0 items-center justify-center ${
          expandable ? 'flex' : 'hidden @min-[104px]/tile:flex'
        } ${hasRealIcon ? 'pinned-tile-lead' : ''}`}
      >
        {expandable && <ExpandChevron expanded={expanded} />}
      </span>

      {/* IL CONTENITORE DELL'ICONA SPARISCE QUANDO NON C'E' UN'ICONA.
          Un riquadro largo ZERO non occupa spazio, ma il `gap-2` della riga
          SI': lo spazio si mette fra due figli, e un figlio vuoto e' comunque
          un figlio. Misurato su una tessera stretta senza icona: 16px di aria
          a sinistra contro 8 a destra, cioe' il nome fuori centro di 4 - lo
          stesso difetto dello slot del chevron, un elemento piu' in la'.
          `hidden` e non `w-0`: toglie il figlio dal flusso, e con lui il suo
          gap. Il segnaposto mentre la sonda gira resta, perche' li' un
          ingombro c'e' e serve (tiene il posto che l'icona avra'). */}
      {/* IN FORMA RIGA IL POSTO DELL'ICONA C'E' SEMPRE, anche vuoto.
          Le due forme vogliono cose opposte, ed e' il motivo per cui questa
          classe ha due rami:
           · QUADRATA (< 104px): il contenuto si CENTRA, e un riquadro vuoto
             col suo gap sposterebbe il centro - va tolto dal flusso.
           · RIGA (>= 104px): i nomi si incolonnano, e un progetto senza icona
             partirebbe 22px prima degli altri. Misurato sulle tessere vere il
             17/08: chat a x=50, progetto senza favicon a x=28, uno con favicon
             a x=54 - TRE colonne per la stessa lista. Segnalato: «c'e' ancora
             spazio a sinistra delle icone chat e manca icona project».
          E' la stessa correzione fatta stamattina sulle RIGHE dell'albero
          (`TopicTree`): superficie diversa, difetto identico. */}
      <span className={`relative flex-shrink-0 items-center justify-center ${
        hasRealIcon || Glyph || iconProbing ? 'flex' : 'hidden @min-[104px]/tile:flex'
      }`}>
        {hasRealIcon
          ? <ProjectFavicon path={projectPath} size={18} />
          : Glyph
            ? <Glyph size={14} className="text-app-text-secondary" aria-hidden="true" />
            // Un progetto la cui icona è ancora in volo tiene il POSTO che
            // l'icona avrà: senza, quando arriva il nome scivola via di 18px a
            // cose ferme. Solo mentre sonda — un progetto che risulta senza
            // icona torna a zero ingombro, che è la decisione già presa.
            : iconProbing
              ? <span aria-hidden="true" className="block w-[18px]" />
              // IL SEGNAPOSTO DELLA FORMA RIGA: largo quanto un glifo (14px),
              // cosi' il nome parte dalla stessa x di chi un'icona ce l'ha.
              // Non disegna niente - la decisione «solo icone vere, nessun
              // monogramma» (16/07) resta intatta: qui si tiene una colonna,
              // non si inventa un'identita'. In forma quadrata il genitore e'
              // `hidden`, quindi questo non esiste e il centro resta il centro.
              : <span aria-hidden="true" className="block w-[14px]" />}
      </span>

      {/* IL NOME LO DECIDE LA FORMA DELLA TESSERA, NON IL CARICAMENTO.
          Sotto la soglia la tessera è troppo stretta perché il titolo dica
          qualcosa: sarebbe una lettera e tre puntini, e un titolo
          lì dentro sarebbe due caratteri e tre puntini: se c'è una favicon a
          reggere l'identità, il nome se ne va e resta l'icona sola, centrata.
          Sopra, la tessera è una riga e il titolo ci sta — troncato, ma
          abbastanza da distinguere due progetti con la stessa icona.

          È una CONTAINER QUERY sulla cella, non un booleano: la larghezza di
          una tessera dipende da quante ne hai messe in riga e da quanto è larga
          la sidebar, cioè da cose che cambiano mentre trascini. Misurata dal
          CSS, la soglia risponde durante il gesto e — soprattutto — non passa
          da nessuno stato asincrono: era proprio la dipendenza dall'icona a far
          lampeggiare il titolo a ogni refresh, disegnato nel frame in cui
          l'icona non era ancora risolta e tolto in quello dopo.

          LA SOGLIA È 104, ed è misurata. Era 72, cioè «la tessera non è più un
          quadrato» — ma una tessera larga 90 non è un quadrato e il titolo lì
          dentro era comunque «e…»: misurato, a 90px il box del nome vale
          SEDICI pixel per una stringa che ne chiede 76. Fra icona, rientri,
          conteggio e slot del comando la tessera si mangia 74px prima di
          arrivare al nome, quindi la domanda giusta non è «è una riga?» ma «ci
          sta una parola?». 74 + 30 (cinque caratteri a 11px, il minimo
          leggibile dell'app) = 104. Sotto, resta l'icona sola e centrata —
          «se non ci entra la parola e c'è già l'icona, togliamola» (Attilio,
          08/08).
          I 104px stanno scritti a mano nella classe perché Tailwind legge il
          sorgente: una variabile qui non genererebbe nessuna regola.

          Senza favicon il nome resta SEMPRE, a qualsiasi larghezza: lì il
          titolo è l'unica identità che la tessera ha, e un glifo di categoria
          da solo — quattro icone-chat identiche — non distingue niente.
          11px è il minimo di leggibilità imposto in tutta l'app: sotto non si
          scende nemmeno per far entrare una parola in più. */}
      <span
        data-testid="pinned-tile-name"
        // CENTRATO DA STRETTO, a sinistra da largo — «in queste condizioni»
        // (Attilio, 08/08), e le condizioni sono la GRIGLIA.
        //
        // In una fila di tessere strette le icone stanno centrate e il nome di
        // chi l'icona non ce l'ha («panea») stava a sinistra: due allineamenti
        // nella stessa fila si leggono come un errore, non come una variante.
        // Ma una tessera SOLA su una riga è larga quanto la colonna, e lì il
        // nome centrato galleggia in mezzo al vuoto — «winfleet» a 180px dal
        // bordo. La soglia separa i due casi: sotto i 200px si è in griglia.
        //
        // È una container query e NON l'esito della sonda dell'icona: la regola
        // che vieta di commutare il layout su uno stato in volo resta intatta —
        // qui si commuta sulla LARGHEZZA, che è misurata.
        // `text-app-text`, non `-secondary`: qui il nome È la scheda. Per chi
        // non ha un'icona è l'unica identità che la tessera mostra, e leggerla
        // in `#aab0ba` invece che in `#e6e8ec` la fa sembrare una didascalia di
        // qualcos'altro — «le schede pinnate non sono effettivamente bianche»
        // (Attilio, 08/08). Il secondo colore resta, ma per le cose meno
        // importanti: non per il nome della cosa che stai guardando.
        // `flex-auto max-w-full` e non `flex-1`: con base 0 il nome prende
        // tutto lo spazio che AVANZA dopo lo slot, quindi si taglia anche
        // quando il «+» non c'è. Con base sul contenuto (limitata alla
        // tessera) il nome dichiara quanto gli serve, e chi cede è lo slot.
        // Vedi lo slot in fondo per la metà mancante della regola.
        className={`relative min-w-0 max-w-full flex-auto truncate-tight text-center @min-[200px]/tile:text-left ${TAB_LABEL} ${
          hasRealIcon ? 'hidden @min-[104px]/tile:block' : ''
        }`}
      >
        {item.name}
      </span>

      {item.notificationCount > 0 && (
        // In RIGA sta in fondo, in linea con tutto il resto. Da QUADRATO no:
        // lì il conteggio in linea ruberebbe larghezza all'unica cosa rimasta
        // — l'icona — e la spingerebbe fuori asse, quindi sale nell'angolo
        // come il badge di un'icona (`pinned-tile-count`, che porta con sé
        // anche il `relative` del caso in riga).
        // Sparisce al passaggio del mouse perché lì, nello stesso posto,
        // arriva il «+» — e due cose sovrapposte non si leggono. Vale ancora
        // dal QUADRATO, dove il badge sta nell'angolo e il bottone gli finisce
        // addosso; in riga adesso c'è lo slot qui sotto e non si toccherebbero
        // più, ma si continua a nascondere entrambi allo stesso modo: un badge
        // che sparisce solo a certe larghezze sarebbe una regola in più da
        // ricordare per guadagnare sedici pixel.
        <NotificationBadge
          count={item.notificationCount}
          className={`flex-shrink-0 group-hover/cell:invisible ${
            hasRealIcon ? 'pinned-tile-count' : 'relative'
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
      {hasActions && (
        <span
          aria-hidden="true"
          data-testid="pinned-tile-action-slot"
          className={`hidden shrink-[9999] group-hover/cell:shrink-0 @min-[104px]/tile:block ${PINNED_TILE_ACTION_SLOT}`}
        />
      )}
    </button>
  );
}
