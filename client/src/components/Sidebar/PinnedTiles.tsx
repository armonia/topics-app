import { COLUMN_GAP } from '../../lib/selectionStyles';
import { useCallback, useEffect, useRef, useState, type ReactNode, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import type { SidebarItem } from '../../lib/buildSidebarItems';
import type { AttentionTier } from '../../types';
import { DND_TYPES } from '../../lib/dndTypes';
import { draggedPaneId } from '../../lib/dragPayload';
import { pinKeyFromPaneId } from '../../state/pane/adapters/paneConfig';
import { PinnedTile } from './PinnedTile';
import { PINNED_TILE_H, PINNED_TILE_CONTAINER, PINNED_TILE_ACTION_INSET_CLASS, pinnedForm } from './pinnedTileMetrics';
import { useMobile } from '@/hooks/useMobile';
import {
  flattenPinnedLayout,
  insertPinnedRow,
  movePinnedTile,
  pinnedDropAllowed,
  pinnedRowWidths,
  placePinnedTile,
  reconcilePinnedLayout,
  reorderWithinRow,
  samePinnedLayout,
  type PinnedDropTarget,
  type PinnedRow,
} from './pinnedLayout';
import { liveTranslate, useCellFlip } from './useCellFlip';

/**
 * L'UNICO passo del blocco: fra due tessere della stessa riga, fra due righe, e
 * sopra la prima riga. Orizzontale e verticale sono lo stesso numero — una
 * griglia in cui le colonne respirano 6px e le righe 0 non è una griglia, è due
 * regole diverse messe vicine. È anche `ROW_INSET`, cioè lo stesso passo con cui
 * la sidebar rientra da ogni bordo.
 *
 * Prima: 1px fra la riga della board e le tessere (il solo `my-px` della card),
 * 0px fra due righe di tessere (si toccavano) e 10px prima del filo. Tre
 * distanze diverse per tre spazi che l'occhio legge come uno.
 */
// Il passo è quello della colonna, importato e non riscritto: prima erano due
// numeri uguali per caso, e le righe hanno già smesso una volta di seguirlo.
const TILE_GAP = COLUMN_GAP;

/** Quanto della sezione possono prendersi le fasce aperte. Il resto della
 *  sidebar deve restare raggiungibile: una tessera espansa non è una modale. */
const EXPANDED_MAX_HEIGHT = '62%';

/**
 * Il cursore del drop — e non è una scelta di parole.
 *
 * Ogni sorgente che può atterrare qui dichiara `effectAllowed = 'move'` (le tab
 * della barra, le righe dentro un gruppo, l'albero). Il modello DnD prescrive
 * che un `dropEffect` NON compreso nell'`effectAllowed` della sorgente venga
 * riportato a `'none'`, e con `'none'` il `drop` non viene proprio consegnato.
 * Il `'copy'` che stava qui era la parola giusta per l'utente («fissare non
 * toglie la tab da dov'era») e quella sbagliata per il browser: accendeva il
 * bersaglio e poi lasciava che il gesto venisse annullato in silenzio.
 */
const DROP_EFFECT = 'move' as const;

/**
 * La tessera come apparirà una volta posata: stesso componente, stessi segnali.
 *
 * Passa da `metaFor` come le tessere vere — un'anteprima che mostra la cosa
 * spenta mentre quella cosa sta lampeggiando racconta un risultato che non
 * arriverà. Inerte per costruzione: nessun handler, nessun drag.
 */
function PinnedTilePreview({
  item,
  metaFor,
  hasActions,
  form,
}: {
  item: SidebarItem;
  metaFor: (item: SidebarItem) => PinnedTileMeta;
  /** L'anteprima non porta il «+» — è inerte — ma deve LASCIARGLI lo stesso
   *  slot della tessera vera, o il nome si troncherebbe a una misura diversa
   *  da quella che avrà un istante dopo il drop. */
  hasActions?: boolean;
  /** The form the tile will have WHERE IT LANDS: alone on a new row it is a
   *  row, inside a row that already has tiles it is a grid tile. The preview
   *  shows the tile it is about to become, alignment included. */
  form?: 'row' | 'grid';
}) {
  const meta = metaFor(item);
  return (
    <PinnedTile
      item={item}
      expanded={false}
      focused={meta.focused}
      attention={meta.attention}
      hasActions={hasActions}
      form={form}
      onToggle={() => {}}
    />
  );
}

export interface PinnedTileMeta {
  focused: boolean;
  attention: AttentionTier | null;
}

/**
 * L'INGRESSO DEL DITO PER CHI VIENE DA FUORI.
 *
 * Col mouse una riga della sidebar trascinata quassù arriva da sé: il browser
 * consegna `dragover` e `drop` al bersaglio sotto il cursore, e la griglia non
 * deve sapere chi l'ha trascinata. Col dito il gesto appartiene a chi l'ha
 * cominciato — la riga — e la griglia non riceve niente: l'unico modo di darle
 * il punto è chiamarla. Queste tre funzioni sono quella chiamata, e dentro
 * fanno esattamente ciò che fanno i gestori del mouse.
 */
export interface PinnedExternalTouch {
  /** Il dito si muove con qualcosa che non è ancora fissato: accende
   *  l'anteprima del posto in cui cadrebbe. */
  move: (key: string, x: number, y: number) => void;
  /** Il dito rilascia: fissa, se il punto è un bersaglio. */
  drop: (key: string, x: number, y: number) => void;
  /** Il gesto è morto senza un rilascio: si spegne tutto. */
  cancel: () => void;
}

/**
 * Il blocco dei Fissati: una griglia di tessere, senza intestazione.
 *
 * ── Perché non c'è più un'etichetta ─────────────────────────────────────────
 * La griglia in cima È l'indicazione. Una fascia di tessere illuminate sopra la
 * lista non si confonde con la lista, e scrivere «FISSATI» sopra costava una
 * riga per dire quello che si vede già. Quello che si perde con l'intestazione
 * — collasso, conteggio, badge aggregato — si perde consapevolmente: il badge
 * aggregato esisteva perché la sezione poteva CHIUDERSI e nascondere il non
 * letto, e a tessere non si nasconde niente (ognuna porta il suo); il collasso
 * serviva a recuperare verticale, che è esattamente ciò che le tessere danno.
 *
 * ── Le righe le componi tu ──────────────────────────────────────────────────
 * Quante per riga non è un'impostazione: è quante ne hai messe. Trascinando una
 * tessera dentro una riga, le tessere di quella riga si stringono in diretta
 * alla misura che avranno — l'anteprima non è una simulazione, è il risultato
 * calcolato in anticipo dalla stessa funzione che poi lo applica.
 *
 * ── Il drag verso la griglia dei pane resta intatto ─────────────────────────
 * Niente `DndContext`: il `PointerSensor` di dnd-kit fa `preventDefault` sul
 * pointerdown e ucciderebbe il `dragstart` nativo, cioè il drag che porta un
 * fissato dentro la griglia. Qui si usa lo stesso HTML5 nativo del resto della
 * sidebar, e la tessera porta i due tipi che servono alle due destinazioni.
 */
export function PinnedTiles({
  items,
  layout,
  onLayoutChange,
  metaFor,
  onToggleItem,
  onContextMenu,
  onPinItem,
  onTouchDragPoint,
  onTouchDropOutside,
  externalTouch,
  resolveItem,
  renderActions,
  renderExpanded,
}: {
  /** I fissati da mostrare, in ordine di pin. Il layout si riconcilia su questi. */
  items: SidebarItem[];
  layout: PinnedRow[];
  onLayoutChange: (next: PinnedRow[]) => void;
  metaFor: (item: SidebarItem) => PinnedTileMeta;
  /** Click su una tessera già espansa, o su una tessera senza contenuto da
   *  espandere: il chiamante decide (aprire la cosa, portarcisi sopra). */
  onToggleItem?: (item: SidebarItem, willExpand: boolean) => void;
  onContextMenu?: (item: SidebarItem, e: React.MouseEvent) => void;
  /** Fissa una cosa arrivata da FUORI (una riga dentro un gruppo, una tab, un
   *  progetto dell'albero). La chiave è già quella di riga: la conversione dalla
   *  pane la fa la griglia. `at` è la cella sotto il cursore quando il drop cade
   *  su una riga o fra due righe — senza, la tessera si accoda.
   *
   *  `griglia` è la disposizione delle tessere VISIBILI con la nuova già al suo
   *  posto: quando la ricerca filtra, gli indici di `at` sono contati su quel
   *  sottoinsieme e non su tutto il layout salvato, quindi da soli mentirebbero
   *  di una riga. Chi riceve la fonde con quello che ha (`mergePinnedLayout`). */
  onPinItem?: (key: string, at?: PinnedDropTarget, griglia?: PinnedRow[]) => void;
  /**
   * DOV'È IL DITO, a ogni movimento e anche quando esce dalla griglia.
   *
   * Col mouse il gesto inverso (una tessera lasciata sulla lista torna una riga)
   * lo serve chi disegna la lista, che riceve i suoi `dragover`. Col dito quegli
   * eventi non esistono: il trascinamento è nostro dal primo pixel all'ultimo,
   * quindi il punto glielo dobbiamo passare noi. `null` vuol dire gesto finito,
   * comunque sia finito: chi disegna l'anteprima di sfissaggio la spegne lì.
   */
  onTouchDragPoint?: (key: string, p: { x: number; y: number } | null) => void;
  /** Il dito ha rilasciato dove la griglia non ha bersagli. Se quel punto valga
   *  uno sfissaggio non lo decidiamo noi: fuori di qui c'è la lista, e lo sa
   *  solo chi la disegna. */
  onTouchDropOutside?: (key: string, x: number, y: number) => void;
  /** Il ref in cui la griglia depone il proprio ingresso per il dito (vedi
   *  `PinnedExternalTouch`). Chi disegna le righe lo passa loro. */
  externalTouch?: React.MutableRefObject<PinnedExternalTouch | null>;
  /** La riga della sidebar per una chiave, anche se NON è fra i fissati: serve
   *  a disegnare l'anteprima come la tessera vera invece che come un rettangolo
   *  colorato. `null` quando la chiave non ha una riga qui (drag da un'altra
   *  finestra, o una pane senza presenza in sidebar). */
  resolveItem?: (key: string) => SidebarItem | null;
  /** I comandi della tessera, sopra di lei e visibili al passaggio del mouse —
   *  il «+» che sulla riga di un progetto apre una tab dentro quel progetto.
   *  Vive FUORI dal bottone: un bottone dentro un bottone è HTML non valido, e
   *  il browser lo srotola spostando l'annidamento a caso. `null` ⇒ niente. */
  /** Le azioni sulla tessera (oggi: il «+» dei progetti). Riceve anche se la
   *  tessera è APERTA, perché il «+» si mostra solo lì: un comando «crea
   *  dentro» su una cosa chiusa promette un posto che non si vede. */
  renderActions?: (item: SidebarItem, aperta: boolean) => ReactNode;
  /** Il contenuto della fascia sotto la riga. `null` ⇒ la tessera non si espande. */
  renderExpanded: (item: SidebarItem) => ReactNode;
}) {
  const { isMobile } = useMobile();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragKey, setDragKey] = useState<string | null>(null);
  // `fromThisRow` si decide all'EVENTO, non al render: `dragKey` è stato, e il
  // primo `dragover` può arrivare prima che React l'abbia applicato — allora la
  // riga si crede bersaglio di un drag ESTERNO e disegna il fantasma invece di
  // riordinare. `dragKeyRef` è aggiornato in modo sincrono dal `dragstart`,
  // quindi la risposta giusta è già disponibile nel momento in cui serve.
  const [dropAt, setDropAt] = useState<
    { rowIdx: number; insertAt: number; fromThisRow: boolean; movingKey: string | null; incoming: SidebarItem | null } | null
  >(null);
  const [newRowAt, setNewRowAt] = useState<number | null>(null);
  const [incomingRow, setIncomingRow] = useState<SidebarItem | null>(null);
  const [adopting, setAdopting] = useState(false);
  // C'è una pane in volo, da qualsiasi parte del programma. Serve SOLO allo
  // stato vuoto, che altrimenti non ha nessun elemento da cui sentire un
  // `dragover`: senza tessere non c'è sezione, e senza sezione non c'è bersaglio.
  const [dragEsterno, setDragEsterno] = useState(false);
  const dragKeyRef = useRef<string | null>(null);
  const radice = useRef<HTMLDivElement>(null);
  /**
   * IL FANTASMA DEL DITO — la tessera che segue il tocco mentre la trascini.
   *
   * Col mouse non serve: il browser disegna da sé l'immagine di trascinamento
   * al `dragstart`. Col dito non c'è nessun `dragstart` e quindi nessuna
   * immagine, e senza non si capisce COSA si sta muovendo: la tessera di
   * partenza si smorza e basta, e l'unico segnale che resta è l'anteprima che
   * si apre a dieci centimetri di distanza. È metà del «non sta funzionando
   * come desktop, va male».
   *
   * Porta anche la MISURA della cella di partenza, letta al sollevamento: il
   * fantasma deve essere largo quanto la tessera che rappresenta, non quanto
   * il suo contenuto.
   */
  const [ghost, setGhost] = useState<{ key: string; w: number; h: number; x: number; y: number } | null>(null);

  const byId = new Map(items.map(i => [i.id, i]));
  const rows = reconcilePinnedLayout(items.map(i => i.id), layout);

  /** Su questa tessera si appoggia un comando? Lo sa solo il chiamante, e la
   *  tessera deve saperlo per riservargli lo slot — anche nelle anteprime, che
   *  altrimenti troncherebbero il nome a una misura che il drop non produrrà. */
  const haAzioni = (item: SidebarItem) => (renderActions?.(item, aperta(item.id)) ?? null) !== null;

  /**
   * Chi ha DAVVERO qualcosa da aprire qui sotto — deciso una volta per render,
   * e non una domanda retorica.
   *
   * La fascia di un progetto esiste solo finché quel progetto ha tab aperte:
   * chiuse tutte, `renderExpanded` torna `null`. `expanded` però è un insieme di
   * INTENZIONI, e nessuno lo puliva — quindi una tessera aperta e poi rimasta
   * senza tab restava `lit` (cioè accesa, cornice e superficie da selezionata)
   * mostrando sotto di sé una fascia grigia vuota, e cliccarla non la spegneva:
   * il ramo «niente da aprire» di `toggle` usciva senza toccare l'insieme. Una
   * tessera illuminata per sempre, senza un gesto che la spenga. È il «a volte
   * mi restano illuminati i pinnati».
   */
  const apribili = new Set(items.filter(i => renderExpanded(i) !== null).map(i => i.id));

  /** Aperta per davvero: l'intenzione dell'utente E qualcosa da mostrare. */
  const aperta = (key: string) => expanded.has(key) && apribili.has(key);

  // Il riordino è un movimento, e si deve vedere muovere.
  useCellFlip(radice);

  // I due callback del dito vivono in un ref perché `clearDrag` deve restare
  // STABILE: sta nelle dipendenze di un effetto che aggancia listener a
  // `window`, e una identità nuova a ogni render li rimonterebbe a ogni render.
  const outsideRef = useRef({ punto: onTouchDragPoint, drop: onTouchDropOutside });
  // L'aggiornamento sta in un effetto SENZA dipendenze, non nel corpo del
  // render: scrivere in un ref durante il render e' vietato dal compilatore
  // React («Cannot access refs during render») perche' rende il render non
  // ripetibile. Un effetto senza dipendenze gira dopo OGNI render, quindi il
  // contenuto resta fresco quanto prima; il valore iniziale copre il primo
  // giro, ed e' gia' quello giusto.
  useEffect(() => {
    outsideRef.current = { punto: onTouchDragPoint, drop: onTouchDropOutside };
  });

  const clearDrag = useCallback(() => {
    // Il gesto è finito: chi disegnava l'anteprima di sfissaggio la spegne. Va
    // detto QUI e non solo nel rilascio, perché un gesto annullato dal sistema
    // (una chiamata, il dito che esce dallo schermo) non passa da nessun drop e
    // lascerebbe in lista una riga fantasma che non torna più indietro.
    const inVolo = dragKeyRef.current;
    if (inVolo) outsideRef.current.punto?.(inVolo, null);
    dragKeyRef.current = null;
    setDragKey(null);
    setDropAt(null);
    setNewRowAt(null);
    setIncomingRow(null);
    setAdopting(false);
    setDragEsterno(false);
    setGhost(null);
  }, []);

  // Il gesto è finito, comunque sia finito.
  //
  // Prima l'azzeramento viveva solo nei nostri `drop` e nell'`onDragEnd` della
  // tessera — cioè copriva i drag che NASCONO qui. Un drag che arriva da fuori
  // e finisce altrove (una riga trascinata sui fissati e poi rilasciata sulla
  // lista) lasciava `adopting`/`dropAt` accesi per sempre: la griglia restava
  // convinta di avere un gesto in corso, e il gesto dopo non funzionava più.
  // È il «faccio avanti e indietro e poi non riesco più».
  //
  // `dragstart` è l'altra metà, e serve allo stato vuoto: il ripiano della pane
  // è già stato posato dalla sorgente quando l'evento arriva fin qui (prima il
  // bersaglio, poi la risalita), quindi basta guardarlo.
  useEffect(() => {
    const fine = () => clearDrag();
    const inizio = () => setDragEsterno(draggedPaneId() !== null);
    window.addEventListener('dragstart', inizio);
    window.addEventListener('dragend', fine);
    return () => {
      window.removeEventListener('dragstart', inizio);
      window.removeEventListener('dragend', fine);
    };
  }, [clearDrag]);

  /** Un drag che possiamo servire: porta il tipo giusto E viene da QUESTA
   *  griglia. Un drag della stessa shape da un'altra finestra porterebbe il
   *  tipo ma non la chiave, e riordinare su una chiave che non abbiamo
   *  significherebbe inventarsi un movimento. */
  const isOurs = (e: React.DragEvent) =>
    dragKeyRef.current !== null && e.dataTransfer.types.includes(DND_TYPES.PINNED_TILE);

  /** Un drag che viene da FUORI e porta una pane: una riga dentro un gruppo,
   *  una tab della barra, il progetto nell'albero. Lasciarla qui vuol dire
   *  «questa la voglio sempre sotto mano», che è esattamente cosa significa
   *  fissare. */
  const isForeignPane = (e: React.DragEvent) =>
    !!onPinItem &&
    dragKeyRef.current === null &&
    (e.dataTransfer.types.includes(DND_TYPES.PANE_TAB) ||
      e.dataTransfer.types.includes(DND_TYPES.PANEL_ID));

  /** La cosa in volo, come RIGA — quella che l'anteprima disegnerà. Durante il
   *  `dragover` il `dataTransfer` non si legge (regola del browser), quindi la
   *  chiave arriva dal ripiano che la sorgente ha lasciato al `dragstart`. Se
   *  non c'è (drag da un'altra finestra) l'anteprima ripiega sul posto vuoto. */
  const incomingItem = (): SidebarItem | null => {
    const paneId = draggedPaneId();
    if (!paneId || !resolveItem) return null;
    return resolveItem(pinKeyFromPaneId(paneId));
  };

  /** La chiave di riga della pane trascinata. Leggibile SOLO nel `drop`:
   *  durante il `dragover` il browser espone i tipi ma non i dati. */
  const foreignKey = (e: React.DragEvent): string | null => {
    const paneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB)
      || e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    return paneId ? pinKeyFromPaneId(paneId) : null;
  };

  /**
   * La tessera che questo gesto sta SPOSTANDO, se è una che sta già in griglia.
   *
   * Non basta guardare da dove parte il drag. La tab di un progetto già fissato,
   * trascinata dalla barra, è una cosa che una tessera ce l'ha: prima veniva
   * trattata come un arrivo — anteprima di una cella nuova, riga che si stringe
   * — e poi il drop non faceva niente, perché fissare una cosa già fissata è un
   * no-op. Un bersaglio che si accende e non risponde. Se la chiave è nostra il
   * gesto è uno spostamento, da qualunque parte arrivi.
   */
  const movingKey = (): string | null => {
    if (dragKeyRef.current) return dragKeyRef.current;
    const paneId = draggedPaneId();
    const key = paneId ? pinKeyFromPaneId(paneId) : null;
    return key && byId.has(key) ? key : null;
  };

  /**
   * Quante tessere VERE della riga stanno a sinistra del cursore.
   *
   * Si misurano le CELLE, non le tessere: la cella d'anteprima porta dentro una
   * `PinnedTile` vera — stessa icona, stesso nome — e quindi anche il suo
   * `data-pinned-tile`, e finiva contata. Con il fantasma nel mucchio l'indice
   * saliva di uno a ogni giro finché non sbatteva in fondo: lasciavi la tessera
   * a metà riga e ti finiva in coda. `insertAt` è un indice dentro `row.keys`,
   * che di celle finte non ne contiene.
   *
   * E si sottrae la traslazione del riordino in corso: `getBoundingClientRect`
   * dice dove la cella è ORA, non dove starà, e misurare il fotogramma farebbe
   * rimbalzare l'indice mentre l'animazione scorre.
   */
  const insertIndexAt = (rowEl: HTMLElement, clientX: number): number => {
    let n = 0;
    for (const cella of rowEl.querySelectorAll<HTMLElement>('[data-pinned-cell]')) {
      const r = cella.getBoundingClientRect();
      const { x } = liveTranslate(cella);
      if (clientX > r.left - x + r.width / 2) n++;
    }
    return n;
  };

  const commit = (next: PinnedRow[]) => {
    if (!samePinnedLayout(rows, next)) onLayoutChange(next);
    clearDrag();
  };

  /* ── IL DITO ──────────────────────────────────────────────────────────────
   *
   * Su iOS il drag and drop di HTML5 non esiste (vedi `useTouchDrag`), quindi
   * tutto ciò che sta qui sopra — `dragover`, `dropEffect`, `dataTransfer` — è
   * inerte su un telefono. Queste tre funzioni sono il ponte: il dito porta
   * solo due numeri, e da quei due numeri si ricava lo STESSO bersaglio che il
   * mouse ricava dagli eventi di trascinamento.
   *
   * Da lì in poi non c'è un secondo percorso: si accendono gli stessi stati
   * (`dropAt` / `newRowAt`), quindi la stessa anteprima — la riga che si
   * stringe, la cella fantasma, la tessera vera al 60% — e si applicano le
   * stesse funzioni pure del modello (`movePinnedTile`, `insertPinnedRow`).
   * Un solo modo di spostare una tessera, due modi di dire dove.
   */

  /** Il bersaglio sotto il punto, o `null` se il dito è fuori dalla griglia.
   *
   *  Si misura per RETTANGOLI e non con `elementFromPoint`: sotto il dito c'è
   *  quasi sempre la tessera trascinata o una sua anteprima, cioè un elemento
   *  che non è né una riga né uno spazio, e risalire i genitori per capirlo
   *  sarebbe la stessa cosa detta peggio. Gli spazi fra le righe vincono sulle
   *  righe perché sono più stretti: a parità di punto, chi ha mirato una
   *  striscia da 6px l'ha mirata apposta. */
  const touchTargetAt = (x: number, y: number): PinnedDropTarget | null => {
    const root = radice.current;
    if (!root) return null;
    for (const gap of root.querySelectorAll<HTMLElement>('[data-pinned-gap-at]')) {
      const r = gap.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { kind: 'newRow', atRowIdx: Number(gap.dataset.pinnedGapAt) };
      }
    }
    for (const rowEl of root.querySelectorAll<HTMLElement>('[data-pinned-row-idx]')) {
      const r = rowEl.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { kind: 'row', rowIdx: Number(rowEl.dataset.pinnedRowIdx), insertAt: insertIndexAt(rowEl, x) };
      }
    }
    return null;
  };

  /** Il dito ha sollevato una tessera: si alza lo stesso stato del `dragstart`
   *  nativo (così anteprime, spazi fra le righe e tessera smorzata funzionano
   *  senza un secondo percorso) e si crea il fantasma, misurando la cella. */
  const onTouchDragLift = (key: string) => () => {
    dragKeyRef.current = key;
    setDragKey(key);
    const cella = radice.current?.querySelector<HTMLElement>(`[data-pinned-cell="${CSS.escape(key)}"]`);
    const r = cella?.getBoundingClientRect();
    if (r) setGhost({ key, w: r.width, h: r.height, x: r.x + r.width / 2, y: r.y + r.height / 2 });
  };

  const onTouchDragMove = (key: string) => (x: number, y: number) => {
    setGhost(g => (g && g.key === key ? { ...g, x, y } : g));
    // Il punto esce SEMPRE, dentro o fuori dalla griglia: è l'equivalente del
    // `dragover` che col mouse arriva alla lista, ed è l'unico evento che sa
    // dove sei davvero. Spegnere l'anteprima altrove è la ricetta del tremolio.
    onTouchDragPoint?.(key, { x, y });
    const target = touchTargetAt(x, y);
    // Fuori dalla griglia l'anteprima si spegne, ma il gesto resta vivo: il
    // dito può rientrare. Spegnerlo qui vorrebbe dire che sbordare di un pixel
    // annulla lo spostamento.
    if (!target || !pinnedDropAllowed(rows, key, target)) {
      setDropAt(null);
      setNewRowAt(null);
      return;
    }
    if (target.kind === 'newRow') {
      setDropAt(null);
      setNewRowAt(target.atRowIdx);
      setIncomingRow(byId.get(key) ?? null);
      return;
    }
    setNewRowAt(null);
    setDropAt({
      rowIdx: target.rowIdx,
      insertAt: target.insertAt,
      fromThisRow: !!rows[target.rowIdx]?.keys.includes(key),
      movingKey: key,
      // CHI ARRIVA, quando arriva da un'ALTRA riga — ed era il bug: qui c'era
      // `null` fisso, quindi la riga di destinazione apriva la sua cella e ci
      // disegnava dentro il rettangolo tratteggiato di ripiego invece della
      // tessera vera. Col mouse quello stesso caso mostra la tessera al 60%.
      // Dentro la stessa riga resta `null`: lì non entra nessuno, le tessere
      // che ci sono si riordinano e basta.
      incoming: rows[target.rowIdx]?.keys.includes(key) ? null : byId.get(key) ?? null,
    });
  };

  const onTouchDragDrop = (key: string) => (x: number, y: number) => {
    const target = touchTargetAt(x, y);
    // FUORI DALLA GRIGLIA IL GESTO NON È FINITO, È UN ALTRO GESTO: col mouse una
    // tessera lasciata sulla lista perde il pin, e col dito finiva qui a fare
    // `clearDrag` e basta. Chi riceve il punto decide se vale uno sfissaggio: il
    // rifiuto (dito sul vuoto, o dentro il blocco dei fissati ma non su una
    // cella) resta un annullamento, come prima.
    if (!target || !pinnedDropAllowed(rows, key, target)) {
      clearDrag();
      onTouchDropOutside?.(key, x, y);
      return;
    }
    if (target.kind === 'newRow') commit(insertPinnedRow(rows, key, target.atRowIdx));
    else commit(movePinnedTile(rows, key, { rowIdx: target.rowIdx, insertAt: target.insertAt }));
  };

  /** Il dito è dentro il blocco dei fissati, anche se non su una cella. Col
   *  mouse è il `dragover` della sezione: lì il drop fissa e ACCODA. */
  const insideSection = (x: number, y: number): boolean => {
    const r = radice.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  /**
   * FISSARE COL DITO: la stessa griglia, chiamata invece che ascoltata.
   *
   * Ogni riga qui sotto ha il suo gemello fra i gestori del mouse, e la
   * differenza è solo da dove arriva il punto. `movingKey` resta `null` per
   * costruzione: chi arriva da fuori non sta muovendo nessuna tessera, ed è la
   * stessa cosa che `pinnedDropAllowed` riceve dal ramo `isForeignPane`.
   */
  const externalFromFinger: PinnedExternalTouch = {
    move: (key, x, y) => {
      // Già fissata: non c'è niente da fissare, e disegnare una cella in arrivo
      // prometterebbe un drop che poi è un no-op.
      if (byId.has(key)) return;
      const target = touchTargetAt(x, y);
      if (!target || !pinnedDropAllowed(rows, null, target)) {
        setDropAt(null);
        setNewRowAt(null);
        setIncomingRow(null);
        setAdopting(insideSection(x, y));
        return;
      }
      setAdopting(false);
      const riga = resolveItem?.(key) ?? null;
      if (target.kind === 'newRow') {
        setDropAt(null);
        setNewRowAt(target.atRowIdx);
        setIncomingRow(riga);
        return;
      }
      setNewRowAt(null);
      setDropAt({
        rowIdx: target.rowIdx,
        insertAt: target.insertAt,
        fromThisRow: false,
        movingKey: null,
        incoming: riga,
      });
    },
    drop: (key, x, y) => {
      const target = touchTargetAt(x, y);
      const dentro = insideSection(x, y);
      clearDrag();
      if (byId.has(key) || !onPinItem) return;
      if (target && pinnedDropAllowed(rows, null, target)) {
        onPinItem(key, target, placePinnedTile([...flattenPinnedLayout(rows), key], rows, key, target));
        return;
      }
      // Dentro il blocco ma non su una cella: si accoda, come il drop della
      // sezione. Fuori dal blocco non è successo niente.
      if (dentro) onPinItem(key);
    },
    cancel: () => clearDrag(),
  };
  // Ogni render, senza dipendenze: le tre funzioni chiudono su `rows` e
  // `byId`, che cambiano a ogni fissaggio. Un handle pubblicato una volta sola
  // risponderebbe sulla griglia di ieri.
  //
  // `useImperativeHandle` e non `ref.current = …`: scrivere dentro una prop e'
  // vietato dal compilatore React (`This value cannot be modified`), e la
  // regola ha ragione — chi possiede il ref e' il genitore, e una scrittura
  // diretta durante l'effetto e' invisibile a chi legge il componente. Questa
  // e' la shape sanzionata per pubblicare un'API imperativa verso l'alto, e
  // fa esattamente la stessa cosa, compreso l'azzeramento allo smontaggio.
  useImperativeHandle(externalTouch, () => externalFromFinger);

  const toggle = (item: SidebarItem) => {
    const willExpand = !aperta(item.id);
    if (!apribili.has(item.id)) {
      // Niente da aprire: il click porta lì e basta. E se era rimasta accesa
      // un'intenzione di quando invece c'era qualcosa, si spegne QUI — altrimenti
      // riaprendo una tab del progetto la fascia si spalancherebbe da sola,
      // ricordando un gesto fatto in un'altra vita della tessera.
      if (expanded.has(item.id)) {
        setExpanded(prev => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
      onToggleItem?.(item, false);
      return;
    }
    setExpanded(prev => {
      const next = new Set(prev);
      if (willExpand) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
    // SOTTO I 768px IL PRIMO TOCCO NON PORTA VIA — la stessa regola della riga
    // di progetto nell'albero, e per lo stesso motivo. «Vale anche per quelli
    // pinnati, dovrebbe essere lo stesso il sistema» (Attilio, 07/08).
    //
    // Lì aprire un progetto CHIUDE il cassetto: se il tocco che apre la fascia
    // è anche quello che ti porta dentro, la fascia non la vedi mai — si apre e
    // sparisce nello stesso istante, insieme a tutta la colonna. Quindi il primo
    // tocco apre e basta; il secondo (sulla tessera già aperta, cioè quando
    // `willExpand` è falso) entra. Col mouse resta com'era: lì aprire non porta
    // via niente, e un secondo clic per entrare sarebbe un ostacolo inventato.
    if (isMobile && willExpand) return;
    onToggleItem?.(item, willExpand);
  };

  if (items.length === 0) {
    // Con zero fissati non c'era NIENTE da colpire: la sezione non si
    // renderizzava affatto, quindi «trascina una cosa qui per fissarla»
    // smetteva di esistere proprio nello stato in cui è l'unico modo per
    // scoprirlo. A riposo resta niente — nessuna fascia vuota che occupa la
    // sidebar per annunciare di essere vuota: il bersaglio nasce solo mentre
    // una pane è davvero in volo, e muore col gesto.
    if (!dragEsterno || !onPinItem) return null;
    return (
      <div
        data-testid="sidebar-pinned-empty-drop"
        role="group"
        aria-label="Fissa qui"
        className="mx-1.5 mb-1.5"
        onDragOver={e => {
          if (!isForeignPane(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = DROP_EFFECT;
        }}
        onDrop={e => {
          if (!isForeignPane(e)) return;
          e.preventDefault();
          e.stopPropagation();
          const key = foreignKey(e);
          if (key) onPinItem(key);
          clearDrag();
        }}
      >
        <div
          className={`${PINNED_TILE_H} pointer-events-none flex items-center justify-center rounded-lg border border-dashed border-app-border text-[11px] text-app-text-tertiary`}
        >
          Fissa qui
        </div>
      </div>
    );
  }

  const anyExpanded = rows.some(r => r.keys.some(k => aperta(k)));

  /**
   * La stessa domanda di `movingKey`, posta IN RESA.
   *
   * E la risposta arriva dallo stato, non dal ripiano sincrono: il ref esiste
   * per gli EVENTI, che possono scattare prima che React abbia applicato
   * `setDragKey`. In resa quel vantaggio non c'è — se stiamo renderizzando, lo
   * stato è già quello — e leggere un ref mentre si rende è il modo classico di
   * disegnare un fotogramma che nessun aggiornamento verrà a correggere.
   */
  const movingRender: string | null = (() => {
    if (dragKey) return dragKey;
    // La tab di un fissato trascinata dalla barra: `dragKey` è nostro solo se il
    // drag nasce da una tessera, ma la chiave può essere comunque una che
    // teniamo. Il ripiano lo dice, e a questo render è già posato (il
    // `dragstart` di finestra ci ha fatto ri-renderizzare).
    const paneId = draggedPaneId();
    const key = paneId ? pinKeyFromPaneId(paneId) : null;
    return key && byId.has(key) ? key : null;
  })();

  /**
   * La chiave che questo gesto sta spostando, se sta già in griglia — decisa una
   * volta per render, così tutte le righe raccontano lo STESSO movimento: quella
   * di arrivo che fa posto e quella di partenza che si stringe.
   */
  const inVolo: string | null = dropAt
    ? dropAt.movingKey
    : newRowAt !== null
      ? movingRender
      : null;

  /** La zona sottile fra due righe (e in fondo): ci si lascia cadere una
   *  tessera per aprire una riga nuova. A riposo è 6px di niente; sotto un drag
   *  compatibile si apre e si illumina, così il bersaglio esiste solo quando
   *  serve colpirlo. */
  const rowGap = (at: number) => {
    // L'ultimo spazio è SOLO un bersaglio, non ritmo: lo spazio sotto il blocco
    // appartiene a ciò che segue (il filo, che porta il suo margine). Dandogli
    // anche 6px a riposo i due si sommerebbero e il filo scivolerebbe via.
    const trailing = at === rows.length;
    // Questa zona serve a qualcosa, per la cosa che è in volo ADESSO?
    //
    // Una tessera che si tiene già una riga tutta sua non ha nessun posto dove
    // andare nello spazio sopra o sotto quella riga: la riga di partenza
    // sparirebbe e ne nascerebbe una identica. Il modello lo sapeva già e
    // rifiutava il gesto — ma la zona si apriva lo stesso, si accendeva e ci
    // disegnava dentro l'anteprima della tessera. Prometteva uno spostamento
    // che poi non avveniva: è il difetto «mi dà la possibilità di spostarla in
    // una riga sotto, ma già sta occupando una riga».
    //
    // Non basta ignorare il drop: senza `preventDefault` la zona non è proprio
    // un bersaglio, quindi il cursore lo dice — «qui no» — invece di dire «qui
    // sì» e poi non fare niente.
    const utile = pinnedDropAllowed(rows, movingRender, { kind: 'newRow', atRowIdx: at });
    // `dragKey` copre entrambi i trasporti: il drag nativo lo alza al
    // `dragstart`, il dito al sollevamento (`onLift`). Una condizione sola.
    const attiva = utile && (dragKey !== null || adopting);
    return (
    <div
      key={`gap-${at}`}
      data-testid="pinned-new-row-zone"
      // Il bersaglio del DITO si trova per rettangolo, non per `dragover`: su
      // iOS quell'evento non esiste. Vedi `touchTargetAt`.
      data-pinned-gap-at={at}
      data-drop-allowed={utile ? 'si' : 'no'}
      onDragOver={e => {
        const ours = isOurs(e);
        if (!ours && !isForeignPane(e)) return;
        if (!pinnedDropAllowed(rows, movingKey(), { kind: 'newRow', atRowIdx: at })) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = DROP_EFFECT;
        setDropAt(null);
        setNewRowAt(at);
        // Chi sta per atterrare: sua, se il drag parte da questa griglia;
        // altrimenti la riga che il ripiano del drag sa nominare.
        const moving = movingKey();
        setIncomingRow(moving ? byId.get(moving) ?? null : incomingItem());
      }}
      onDragLeave={e => {
        // Come per la riga: `dragleave` scatta anche entrando in un FIGLIO —
        // qui il rettangolo tratteggiato del posto vuoto — e senza questa
        // guardia la zona si chiudeva proprio mentre ci passavi sopra.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setNewRowAt(cur => (cur === at ? null : cur));
      }}
      onDrop={e => {
        const ours = isOurs(e);
        if (!ours && !isForeignPane(e)) return;
        const moving = ours ? dragKeyRef.current : movingKey();
        if (!pinnedDropAllowed(rows, moving, { kind: 'newRow', atRowIdx: at })) return;
        e.preventDefault();
        // La sezione ha un `drop` suo che fissa SENZA posizione: se il gesto è
        // già stato servito qui, quello dietro accoderebbe la tessera dopo
        // averla piazzata.
        e.stopPropagation();
        const key = ours ? dragKeyRef.current : foreignKey(e);
        if (!key) { clearDrag(); return; }
        // Già in griglia (anche arrivando da fuori: la tab di un fissato) ⇒ è
        // uno spostamento, non un pin.
        if (byId.has(key)) { commit(insertPinnedRow(rows, key, at)); return; }
        const target: PinnedDropTarget = { kind: 'newRow', atRowIdx: at };
        onPinItem?.(key, target, placePinnedTile([...flattenPinnedLayout(rows), key], rows, key, target));
        clearDrag();
      }}
      // Col dito la zona attiva è più alta: 8px sono un bersaglio da cursore, e
      // qui ci si infila un polpastrello per aprire una riga nuova.
      className={`mx-1.5 transition-all duration-100 ${
        newRowAt === at ? '' : attiva ? (isMobile ? 'h-5' : 'h-2') : ''
      }`}
      // Mostrando l'anteprima questo spazio DIVENTA una riga, e una riga ha
      // il suo respiro sopra e sotto: senza, la tessera in arrivo toccava
      // quelle già in griglia mentre tutte le altre stanno a 6px — cioè
      // l'anteprima mostrava una spaziatura che il risultato non avrebbe avuto.
      style={
        newRowAt === at
          ? { paddingTop: TILE_GAP, paddingBottom: TILE_GAP }
          : attiva
            ? undefined
            // LA ZONA IN TESTA VALE MEZZO PASSO, ed è un MARGINE, non un'altezza.
            //
            // Fra due righe di tessere questa zona e' l'UNICO separatore, quindi
            // vale TILE_GAP pieno. Sopra la PRIMA riga no: li' sopra c'e' gia' il
            // mezzo passo di chi precede — il contenitore che scorre, o la card
            // che sta sopra la sezione — e i due si sommavano (misurato 9px
            // sotto l'header della colonna contro i 6 di ogni altro stacco).
            //
            // Mezzo passo scritto come `margin-top` e non come `height` perché
            // quando la sezione dei fissati è il PRIMO blocco della colonna
            // anche questa metà deve sparire, e a toglierla è la regola
            // `.sidebar-column > :first-child > :first-child` (index.css), che
            // sa azzerare un margine e non un'altezza. Il comportamento visivo
            // è identico — un div vuoto alto 0 con 3px di margine occupa i
            // soliti 3 — e quello di trascinamento pure: durante un drag questa
            // zona prende `h-2`/`h-5` da `attiva`, e questo stile non si applica.
            //
            // In coda resta 0 perche' lo spazio sotto lo porta il filo.
            : trailing
              ? { height: 0 }
              : at === 0
                ? { height: 0, marginTop: TILE_GAP / 2 }
                : { height: TILE_GAP }
      }
    >
      {/* La riga nuova si vede per quello che sarà: la tessera vera, a tutta
          larghezza, al 60%. Prima era una barra azzurra — che dice «qui», ma
          non dice COSA, ed è l'unica cosa che uno vuole sapere mentre tiene
          premuto. Senza una riga da nominare (drag da un'altra finestra) resta
          il posto vuoto, tratteggiato nel grigio dei bordi: nessun colore
          acceso per dire «non lo so». */}
      {newRowAt === at && (
        incomingRow
          ? <div data-testid="pinned-drop-preview" className={`${PINNED_TILE_CONTAINER} opacity-60 pointer-events-none`}>
              <PinnedTilePreview item={incomingRow} metaFor={metaFor} hasActions={haAzioni(incomingRow)} form="row" />
            </div>
          : <div
              data-testid="pinned-drop-ghost"
              // Non è un bersaglio: è il disegno di uno. Restando cliccabile si
              // prendeva il `dragleave` della zona che l'aveva appena aperta —
              // e la zona si chiudeva proprio mentre ci passavi sopra.
              className={`${PINNED_TILE_H} pointer-events-none rounded-lg border border-dashed border-app-border`}
            />
      )}
    </div>
    );
  };

  return (
    <div
      ref={radice}
      data-testid="sidebar-pinned-section"
      // Nessun alone sulla sezione. L'anteprima è la tessera vera nella cella
      // dove atterrerà: un riquadro azzurro sopra direbbe una seconda volta,
      // più forte e con meno precisione, ciò che si sta già vedendo. `adopting`
      // resta perché apre gli spazi fra le righe — quelli sì devono diventare
      // colpibili — non perché dipinga qualcosa.
      className="flex flex-col min-h-0 flex-shrink-0 rounded-lg"
      style={anyExpanded ? { maxHeight: EXPANDED_MAX_HEIGHT } : undefined}
      role="group"
      aria-label="Fissati"
      // Lasciare qui una cosa che arriva da fuori la FISSA. È il gesto inverso
      // di trascinarla via, e senza di esso l'unica strada per fissare era il
      // menu contestuale — che dentro una card di gruppo non tutte le righe hanno.
      onDragOver={e => {
        if (!isForeignPane(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = DROP_EFFECT;
        if (!adopting) setAdopting(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setAdopting(false);
        setDropAt(null);
        setNewRowAt(null);
      }}
      onDrop={e => {
        if (!isForeignPane(e)) { setAdopting(false); return; }
        e.preventDefault();
        e.stopPropagation();
        const key = foreignKey(e);
        if (key) onPinItem?.(key);
        clearDrag();
      }}
    >
      {rows.map((row, rowIdx) => {
        const over = dropAt?.rowIdx === rowIdx;
        const dragFromThisRow = over ? dropAt.fromThisRow : false;
        // Da FUORI la riga guadagna una cella: si mostra il fantasma e le
        // larghezze che avrà. Da DENTRO il conteggio non cambia, e prima non si
        // mostrava niente — cioè proprio nel caso più comune (riordinare due
        // tessere vicine) trascinavi alla cieca. Ora la riga si RIORDINA in
        // diretta: quello che vedi mentre tieni premuto è come resterà.
        const adding = over && !dragFromThisRow;
        const reordering = over && dragFromThisRow;
        const openHere = row.keys.filter(k => aperta(k) && byId.has(k));

        // La riga da cui la tessera sta USCENDO mostra che sta uscendo. Senza,
        // l'anteprima raccontava metà movimento: la riga d'arrivo si stringeva
        // per fare posto, quella di partenza restava larga com'era, e a drop
        // fatto scattava. Non quando la riga resterebbe VUOTA: farla sparire
        // sotto un cursore sospeso sposterebbe di una riga tutti i bersagli
        // sotto — compreso quello che si sta mirando.
        const uscente =
          inVolo !== null && !over && row.keys.length > 1 && row.keys.includes(inVolo)
            ? inVolo
            : null;

        let cells: Array<string | null> = uscente
          ? row.keys.filter(k => k !== uscente)
          : [...row.keys];
        if (adding) {
          // Il fantasma è una cella in più: le chiavi vanno interlacciate con
          // lui per restare allineate alle larghezze.
          cells.splice(dropAt.insertAt, 0, null);
        } else if (reordering && dropAt.movingKey) {
          // La STESSA funzione che il drop applicherà. Prima erano due formule
          // gemelle in due posti — una qui, una implicita nel `pluck`+`splice`
          // del modello — e divergevano su ogni spostamento verso destra:
          // vedevi [b, a, c] mentre tenevi premuto e ti restava [b, c, a].
          cells = reorderWithinRow(row.keys, dropAt.movingKey, dropAt.insertAt);
        }

        // Un conteggio diverso vuol dire larghezze diverse, e sono SEMPRE
        // quelle che il drop produrrà: stessa funzione, chiamata in anticipo.
        // A parità di conteggio (riordino) le larghezze salvate restano quelle.
        const widths =
          cells.length === row.keys.length ? row.widths : pinnedRowWidths(cells.length);

        // FORM AND ALIGNMENT ARE ONE DECISION, and it is not taken here: the
        // rule ("one tile on the row = a row, two or more = a grid") and what
        // each form does to the content both live in `pinnedTileMetrics`, so
        // the grid, the tile and the drop preview cannot drift apart. Counted
        // on the cells being DRAWN (ghost included), not on the saved row.
        const shape = pinnedForm(cells.length);

        return (
          <div key={`row-${rowIdx}`} className="flex flex-col min-h-0">
            {rowGap(rowIdx)}
            <div
              data-testid="pinned-row"
              data-pinned-row-idx={rowIdx}
              className="flex items-stretch px-1.5 flex-shrink-0"
              style={{ gap: TILE_GAP }}
              onDragOver={e => {
                const ours = isOurs(e);
                if (!ours && !isForeignPane(e)) return;
                // La riga GUADAGNA una cella solo se la tessera non è già sua.
                // Piena vuol dire piena: oltre `PINNED_ROW_MAX` le tessere
                // diventano più strette del cursore che deve riprenderle, e
                // nessun gesto sa più disfare la riga. Non essendo un bersaglio
                // il cursore lo dice, e gli spazi qui sopra e qui sotto restano
                // aperti: il gesto viene guidato a una riga nuova.
                const moving = ours ? dragKeyRef.current : movingKey();
                if (!pinnedDropAllowed(rows, moving, { kind: 'row', rowIdx, insertAt: 0 })) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = DROP_EFFECT;
                setNewRowAt(null);
                // Da fuori non c'è chiave da muovere: la riga GUADAGNA una
                // cella, quindi fantasma + larghezze finali — la stessa
                // anteprima del riordino, per lo stesso motivo (vedere dove
                // finisce prima di lasciare).
                setDropAt({
                  rowIdx,
                  insertAt: insertIndexAt(e.currentTarget, e.clientX),
                  fromThisRow: moving !== null && row.keys.includes(moving),
                  movingKey: moving,
                  // Chi arriva, chiunque sia. Da fuori lo nomina il ripiano
                  // del drag; da un'ALTRA riga di questa griglia lo sappiamo
                  // già — e proprio quel caso mostrava il rettangolo grigio di
                  // ripiego al posto della tessera, cioè l'anteprima sbagliata
                  // nel movimento più comune dopo il riordino.
                  // Dentro la stessa riga resta `null`: lì non entra nessuno,
                  // le tessere che ci sono si riordinano.
                  incoming: moving
                    ? (row.keys.includes(moving) ? null : byId.get(moving) ?? null)
                    : incomingItem(),
                });
              }}
              onDragLeave={e => {
                // Solo quando si esce DAVVERO dalla riga: `dragleave` scatta
                // anche passando da una tessera all'altra dentro la stessa riga.
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDropAt(cur => (cur?.rowIdx === rowIdx ? null : cur));
              }}
              onDrop={e => {
                const ours = isOurs(e);
                if (!ours && !isForeignPane(e)) return;
                const moving = ours ? dragKeyRef.current : movingKey();
                if (!pinnedDropAllowed(rows, moving, { kind: 'row', rowIdx, insertAt: 0 })) return;
                e.preventDefault();
                e.stopPropagation(); // vedi `rowGap`: la sezione fissa senza posizione
                const insertAt = insertIndexAt(e.currentTarget, e.clientX);
                const key = ours ? dragKeyRef.current : foreignKey(e);
                if (!key) { clearDrag(); return; }
                if (byId.has(key)) { commit(movePinnedTile(rows, key, { rowIdx, insertAt })); return; }
                const target: PinnedDropTarget = { kind: 'row', rowIdx, insertAt };
                onPinItem?.(key, target, placePinnedTile([...flattenPinnedLayout(rows), key], rows, key, target));
                clearDrag();
              }}
            >
              {cells.map((key, i) => {
                const flex = { flex: `${widths[i] ?? 1 / cells.length} 1 0%`, minWidth: 0 };
                if (key === null) {
                  // La cella che nascerà, disegnata con la COSA che ci cade
                  // dentro: stessa icona, stesso nome, stessa tinta che avrà un
                  // istante dopo. Al 60% perché è ancora un'ipotesi, non un
                  // fatto. Il rettangolo tratteggiato resta solo quando non
                  // c'è una riga da nominare — e allora è grigio, non azzurro:
                  // un colore acceso per dire «non lo so» è rumore.
                  return (
                    <div key="ghost" style={flex} className={`${PINNED_TILE_CONTAINER} min-w-0`}>
                      {dropAt?.incoming
                        ? <div data-testid="pinned-drop-preview" className="opacity-60 pointer-events-none">
                            <PinnedTilePreview item={dropAt.incoming} metaFor={metaFor} hasActions={haAzioni(dropAt.incoming)} form={shape} />
                          </div>
                        : <div
                            data-testid="pinned-drop-ghost"
                            className={`${PINNED_TILE_H} pointer-events-none rounded-lg border border-dashed border-app-border`}
                          />}
                    </div>
                  );
                }
                const item = byId.get(key);
                if (!item) return null;
                const meta = metaFor(item);
                const actions = renderActions?.(item, aperta(key)) ?? null;
                return (
                  <div
                    key={key}
                    // Il marcatore della cella VERA, e serve a due cose che
                    // devono restare la stessa: il FLIP che la anima quando
                    // cambia posto, e la misura di quante ne stanno a sinistra
                    // del cursore. Il fantasma non ce l'ha — non è una tessera,
                    // è il posto che una tessera prenderà.
                    data-pinned-cell={key}
                    style={flex}
                    className={`${PINNED_TILE_CONTAINER} relative group/cell min-w-0 ${
                      dropAt?.movingKey === key ? 'opacity-70 transition-opacity' : ''
                    }`}
                  >
                    {/* I comandi stanno SOPRA la tessera, non dentro: fratelli
                        del bottone, non figli. Al centro del lato destro — un
                        angolo in basso sembrava appoggiato lì, e il badge tiene
                        già quello in alto. Sopra, a destra e sotto stanno alla
                        stessa distanza: la tessera è alta quanto il «+» più due
                        volte il suo rientro.

                        `raised-control-overlay`: sotto la vibrancy il fondo di
                        un comando è un'alpha (6-10%), scelta apposta per
                        partecipare al vetro. Va bene per un bottone in fila;
                        qui il bottone sta SOPRA contenuto vivo — il nome e la
                        tinta della tessera — e a quell'alpha ci si legge
                        attraverso. La variante non lo rende opaco: sfoca ciò
                        che gli passa sotto, così resta di vetro e smette di
                        essere un velo. Vedi index.css. */}
                    {actions && (
                      <div
                        // Il rientro da destra è lo STESSO spazio che il bottone
                        // ha sopra e sotto — ma ora è DERIVATO da quello, non il
                        // contrario: `(altezza tessera − box) / 2`, che con la
                        // tessera alta come una riga fa 3 col mouse e 4 col dito.
                        // Vedi PINNED_TILE_ACTION_INSET_CLASS, dove c'è anche il
                        // giro che ho fatto per arrivarci.
                        // In CLASSE e non più in `style`: serve un ramo `md:`, e
                        // uno stile in linea nessuna media query lo raggiunge.
                        className={`raised-control-overlay absolute top-1/2 -translate-y-1/2 z-10 hidden group-hover/cell:flex ${PINNED_TILE_ACTION_INSET_CLASS}`}
                      >
                        {actions}
                      </div>
                    )}
                    <PinnedTile
                      item={item}
                      // Row or grid: the two alignments of the column, told by
                      // the layout and not measured from a width.
                      form={shape}
                      // Non `expanded.has(key)`: l'intenzione da sola non basta
                      // a dirsi aperta, e una tessera accesa senza una fascia
                      // sotto è una tessera accesa senza motivo.
                      expanded={aperta(key)}
                      // La stessa domanda che fa `toggle`: se non c'è niente da
                      // aprire il click porta e basta, e la tessera non deve
                      // promettere una fascia che non arriva.
                      expandable={apribili.has(key)}
                      // Il «+» qui sopra non è figlio della tessera e lei non
                      // lo può misurare: glielo diciamo, così gli lascia lo
                      // slot invece di finirci sotto col nome.
                      hasActions={actions !== null}
                      focused={meta.focused}
                      attention={meta.attention}
                      dragging={dragKey === key && !reordering}
                      onToggle={() => toggle(item)}
                      onContextMenu={e => onContextMenu?.(item, e)}
                      onDragStart={() => { dragKeyRef.current = key; setDragKey(key); }}
                      onDragEnd={clearDrag}
                      onTouchDragStart={onTouchDragLift(key)}
                      onTouchDragMove={onTouchDragMove(key)}
                      onTouchDragDrop={onTouchDragDrop(key)}
                    />
                  </div>
                );
              })}
            </div>

            {/* Le fasce delle tessere aperte DI QUESTA RIGA, subito sotto di
                lei: è letteralmente «sotto la riga dove si trova il progetto».
                Più fasce aperte si dividono l'altezza (`flex: 1 1 0`), e ognuna
                scorre per conto suo invece di spingere fuori le altre. */}
            {openHere.map(key => {
              const item = byId.get(key)!;
              return (
                <div
                  key={`band-${key}`}
                  data-testid="pinned-expansion"
                  data-pinned-expansion={key}
                  // Stesso passo di tutto il resto sopra la fascia; sotto ci
                  // pensa lo spazio della riga seguente (o il filo, se è
                  // l'ultima): due margini che si sommano sono un ritmo rotto.
                  //
                  // IL FONDO È QUELLO DEL «CONTENITORE QUIETO», e adesso è UNO.
                  // La stessa idea — un riquadro che raccoglie roba senza
                  // chiedere attenzione — era dipinta con tre alpha diverse in
                  // tema scuro: 0.03 qui, 0.05 sulla card del gruppo attivo
                  // (SpaceGroups), 0.06 in SELECTED_SURFACE_SOFT. In tema chiaro
                  // erano già tutte 0.03, quindi la divergenza si vedeva solo al
                  // buio e solo affiancando le superfici, cioè nella condizione
                  // normale della sidebar. Vale 0.06 — l'alpha che le altre due
                  // avevano già — così i tre riquadri sono lo stesso riquadro.
                  className="flex-1 min-h-0 overflow-y-auto sidebar-scroll mx-1.5 mt-1.5 mb-0 rounded-lg bg-black/[0.03] dark:bg-white/[0.06]"
                  onKeyDown={e => {
                    if (e.key !== 'Escape') return;
                    e.stopPropagation();
                    setExpanded(prev => {
                      const next = new Set(prev);
                      next.delete(key);
                      return next;
                    });
                  }}
                >
                  {renderExpanded(item)}
                </div>
              );
            })}
          </div>
        );
      })}
      {rowGap(rows.length)}
      {/* Il fantasma, sopra tutto e fuori dal flusso. `pointer-events: none` o
          si mangerebbe il tocco che lo sta muovendo; leggermente ingrandito e
          con un'ombra, come fa iOS quando raccogli un'icona — «l'ho in mano» va
          detto, non lasciato intuire.

          È l'anteprima del gesto col dito ANCHE per il contratto condiviso
          (`lib/dragPreview`): porta `data-drag-preview`, quindi chi legge il DOM
          la trova dov'è per ogni altra superficie. Non la costruisce
          `startTouchDragPreview` perché qui c'è di meglio — la tessera VERA, con
          la sua icona, il suo fondo e il suo badge — e una seconda scheda sotto
          lo stesso dito sarebbe il «si vede doppio». */}
      {ghost && byId.has(ghost.key) && createPortal(
        <div
          data-testid="pinned-touch-ghost"
          data-drag-preview=""
          className={`pointer-events-none fixed z-50 opacity-90 drop-shadow-lg ${PINNED_TILE_CONTAINER}`}
          style={{
            width: ghost.w,
            height: ghost.h,
            left: ghost.x,
            top: ghost.y,
            transform: 'translate(-50%, -50%) scale(1.06)',
          }}
        >
          <PinnedTilePreview
            item={byId.get(ghost.key)!}
            metaFor={metaFor}
            hasActions={haAzioni(byId.get(ghost.key)!)}
            // The ghost is the tile as it is RIGHT NOW, so it keeps the form of
            // the row it was lifted from: a full-width tile that turned into a
            // centred square under the finger would look like a different one.
            form={rows.find(r => r.keys.includes(ghost.key))?.keys.length === 1 ? 'row' : 'grid'}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
