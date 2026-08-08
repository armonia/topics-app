/**
 * COSA CI STA SULLA RIGA «BOARD», e cosa cede per primo.
 *
 * Attilio, 07/08: «sul tastino del board, nella sidebar, mettere anche un
 * raggruppamento per quelli che ci entrano effettivamente nello spazio, dei
 * task per progetto, utilizzando ovviamente l'icona del progetto».
 *
 * «Quelli che ci entrano» è la parte che va MISURATA, non indovinata: la
 * sidebar si ridimensiona col trascinamento del bordo, e un numero fisso di
 * pastiglie o sborda o lascia mezza riga vuota. Le funzioni qui sotto sono
 * pure — una raccoglie, le altre tagliano — così la decisione si può provare
 * senza montare niente, che è l'unico modo di verificare una regola di ritaglio.
 *
 * ── PERCHÉ IL RITAGLIO È UNO SOLO, PER TUTTA LA RIGA ────────────────────────
 * Prima ce n'era mezzo: i conteggi per colonna erano `flex-shrink-0` assoluti e
 * le pastiglie l'unico `flex-1`, quindi il 100% di ogni deficit atterrava
 * sull'unica cosa che il prodotto dichiara indispensabile. Coi numeri: colonna
 * a 256px ⇒ riga 244 ⇒ contenuto 228, di cui ~70 se li prendono glifo, nome e
 * spazi; a TRE colonne aperte i conteggi ne mangiano altri 78 e alle pastiglie
 * ne restano ~50, cioè ZERO pastiglie. Tre colonne aperte è il caso normale,
 * non quello estremo: bastava avere lavoro in review, in corso e in coda perché
 * i progetti sparissero dalla riga.
 *
 * Adesso la ripartizione è dichiarata e in un posto solo ({@link fitBoardRow}),
 * con una scala di priorità esplicita:
 *   1. i conteggi hanno la precedenza, ma NON sono incomprimibili: oltre un
 *      certo punto la coda («todo», «backlog») si arrotola in un numero solo;
 *   2. alle pastiglie resta un PAVIMENTO — una pastiglia solo-icona — che i
 *      conteggi non possono superare;
 *   3. quello che avanza va alle pastiglie, col nome finché il nome ci sta.
 */
import type { BoardProjectRef } from '../../lib/board';
import type { BoardTask, TaskStatus } from '../../lib/board';
import { resolveProjectRefs } from '../../lib/boardProjectsStore';
import { STATUS_GLYPH_PX } from '../../lib/board';

export interface BoardProjectChip {
  projectId: string;
  /** Nome leggibile — dall'indice quando c'è, dall'id ripulito altrimenti. */
  name: string;
  /** Il percorso su disco: senza, `ProjectFavicon` non ha da dove risolvere
   *  l'icona. Vale `''` per un progetto che l'indice non conosce (cartella
   *  sparita, indice non ancora arrivato): la pastiglia esiste lo stesso, col
   *  solo nome, invece di far sparire dei task dal conteggio. */
  path: string;
  /** Quanti task APERTI ha questo progetto. */
  n: number;
}

/**
 * I progetti presenti fra i task aperti, dal più carico al meno carico (a pari
 * numero, in ordine di nome, così l'ordine non balla fra un giro e l'altro).
 *
 * `done` resta fuori, come per il conteggio della riga e per i glifi di stato:
 * la board si annuncia per il lavoro APERTO.
 */
export function boardProjectChips(
  byStatus: Record<TaskStatus, BoardTask[]> | undefined,
  index: BoardProjectRef[] | null,
): BoardProjectChip[] {
  if (!byStatus) return [];
  const counts = new Map<string, number>();
  for (const [status, tasks] of Object.entries(byStatus)) {
    if (status === 'done') continue;
    for (const t of tasks) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const refs = resolveProjectRefs([...counts.keys()], index);
  return refs
    .map((r) => ({ projectId: r.projectId, name: r.name, path: r.path, n: counts.get(r.projectId) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/**
 * LE TRE LARGHEZZE DI UNA PASTIGLIA, e perché sono tre e non una elastica.
 *
 * Fisse, non «quanto serve»: l'icona di un progetto arriva da una richiesta di
 * rete, quindi una pastiglia che si adatta al contenuto cambierebbe misura
 * quando l'icona atterra — e il numero di pastiglie visibili cambierebbe con
 * lei, a cose ferme. Il layout non si decide su uno stato asincrono: lo slot è
 * dichiarato e l'icona ci entra dentro, presente o assente che sia.
 *
 * ── IL NUMERO È USCITO, E POI È RIENTRATO DALLA PORTA GIUSTA ────────────────
 * Portava il conteggio dei task di quel progetto, e su una riga larga 244px il
 * risultato misurato era: UNA pastiglia in modo solo-icona che diceva «31», poi
 * «+6», poi i conteggi per colonna «8» e «36». Quattro numeri in fila, di cui
 * uno senza nome né glifo accanto — «si confondono i numeri» (Attilio, 08/08),
 * ed è letteralmente vero: 31 e 36 sono la stessa forma. Quindi il numero è
 * stato tolto.
 *
 * Poi: «non vedo cmq il conteggio task nelle chip». Le due richieste non si
 * contraddicono, ma insieme dicono una cosa precisa: il numero deve ESSERCI e
 * non deve poter essere letto come uno dei conteggi di stato. Rimetterlo dentro
 * la pastiglia da 58 lo farebbe comparire subito — misurato, non taglia niente —
 * ma il nome scenderebbe da 34px a 16, cioè due caratteri: si baratta l'identità
 * per il numero, e la confusione torna da un'altra porta.
 *
 * Il posto l'ha liberato la CODA: `todo` e `backlog` sono usciti dal riassunto
 * (vedi `SUMMARY_STATUSES`), i conteggi sono passati da 63px a 25-56, e le
 * pastiglie da 90,84 a 97-129. In quello spazio la pastiglia ci sta col nome E
 * col numero. Il numero ha una scatola sua, tono e peso diversi, e sta accanto
 * al nome del progetto a cui appartiene: non è più un numero che galleggia.
 *
 * · `CHIP_W_NAME_COUNT` = 84 — 8 di padding + 20 di slot icona + 4 + 34 di nome
 *   + 4 + 14 di numero (due cifre tabellari a 11px).
 * · `CHIP_W_NAME` = 66 — la stessa senza il numero: 8 + 20 + 4 + 34. I 34 sono
 *   cinque-sei caratteri a 11px: un troncamento, non un moncone.
 * · `CHIP_W_ICON` = 28 — solo icona: 8 + 20.
 *
 * LO SLOT È 20 E NON 12, ed è una decisione presa coi numeri sul tavolo: in un
 * quadrato da 12 un logo-scritta (`acquapub` 256×119, `edm-contratto` 3235×1224)
 * rende 4-5px di inchiostro, cioè niente. In 20×12 si vede. Lo pagano anche i
 * loghi quadrati, che restano 12×12 centrati con 4px di aria per lato. Otto
 * pixel per pastiglia si potevano permettere solo dopo che `backlog` è uscito dal
 * riassunto: con i vecchi conteggi da 63px la pastiglia da 84 non ci stava e la
 * riga sarebbe tornata muta.
 *
 * SONO UNA SCALA, non tre varianti da scegliere: si prova la più ricca e si
 * scende solo quando non ne entra NEMMENO UNA. Il secondo e il terzo gradino
 * sono degradi onesti — un nome senza numero dice ancora chi; un'icona sola dice
 * chi a chi ha un'icona, e per chi non ce l'ha (niente monogrammi, niente
 * tessere generate) resta una tessera muta col suo tooltip. Muta, ma non
 * ambigua: è la cifra anonima che era il difetto, non il silenzio.
 */
export const CHIP_W_NAME_COUNT = 84;
export const CHIP_W_NAME = 66;
export const CHIP_W_ICON = 28;
/** Lo spazio fra due elementi della riga (`gap-1.5`, lo stesso passo). */
export const CHIP_GAP = 6;
/** Il «+N» finale: due caratteri a 10px più il suo respiro. */
export const MORE_W = 22;

/** Il glifo di stato di un conteggio: {@link StatusIcon} reso 1:1 col suo
 *  viewBox — sotto quella misura il tratto cade fra due pixel. Importato e non
 *  riscritto: erano due numeri e sono già stati d'accordo per sbaglio una volta
 *  di troppo. */
const COUNT_GLYPH_W = STATUS_GLYPH_PX;
/** `gap-1` fra il glifo e il suo numero. */
const COUNT_GAP = 4;
/** Una cifra a 11px, tabellare. Arrotondata per ECCESSO: una stima corta
 *  farebbe sbordare i conteggi, che sono l'ultima cosa a poter sparire.
 *  Era 6, tarata sui 10px di prima — «i numeri contatori sono troppo piccoli
 *  per lo stato» (Attilio, 08/08), e 10px era comunque sotto il minimo di
 *  leggibilità che l'app si è già data altrove (vedi PinnedTile). */
const DIGIT_W = 7;

/** Quanto occupa un conteggio (glifo + numero) con quel valore dentro. */
export function countWidth(n: number): number {
  return COUNT_GLYPH_W + COUNT_GAP + DIGIT_W * String(n).length;
}

/** Come si disegnano le pastiglie, dalla più ricca alla più povera. */
export type ChipMode = 'name-count' | 'name' | 'icon';

/** La scala dei gradini, con la sua larghezza. L'ordine È la priorità, e vive
 *  qui una volta sola: `fitProjectChips` la scorre, e il test la rilegge. */
export const CHIP_MODES: readonly { mode: ChipMode; w: number }[] = [
  { mode: 'name-count', w: CHIP_W_NAME_COUNT },
  { mode: 'name', w: CHIP_W_NAME },
  { mode: 'icon', w: CHIP_W_ICON },
];

export interface FittedChips<T> {
  shown: T[];
  /** Quante sono rimaste fuori. `0` ⇒ nessun «+N» da disegnare. */
  hidden: number;
  mode: ChipMode;
}

/** Un conteggio per colonna, nell'ordine in cui conta per chi guarda. */
export interface BoardCount {
  status: TaskStatus;
  n: number;
}

export interface FittedCounts {
  shown: BoardCount[];
  /** La coda che non ci stava, in un numero solo. `null` ⇒ ci stavano tutti. */
  rolled: { statuses: TaskStatus[]; n: number } | null;
}

/** Quanto occupano, affiancati, i conteggi decisi da {@link fitStatusCounts}. */
export function countsSpan(fitted: FittedCounts): number {
  const widths = fitted.shown.map((c) => countWidth(c.n));
  if (fitted.rolled) widths.push(countWidth(fitted.rolled.n));
  if (widths.length === 0) return 0;
  return widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * CHIP_GAP;
}

/**
 * Quanti conteggi stanno in `width`, e cosa si arrotola.
 *
 * L'ordine in cui arrivano è già quello di priorità (chi aspetta te, chi sta
 * lavorando, poi la coda), quindi si tiene la TESTA e si arrotola la CODA: «2
 * in review, 1 in corso, ⋯4» dice ancora tutto ciò che cambia una decisione,
 * mentre perdere il review per mostrare il backlog no.
 *
 * `chipFloor` è il pavimento che i conteggi non possono mangiare: lo spazio di
 * una pastiglia solo-icona. È il punto in cui la priorità si inverte rispetto a
 * prima — i conteggi cedono, invece di lasciare a zero l'unica cosa che dice
 * DOVE sta quel lavoro.
 */
export function fitStatusCounts(width: number, chipFloor: number, counts: readonly BoardCount[]): FittedCounts {
  if (counts.length === 0) return { shown: [], rolled: null };
  const widths = counts.map((c) => countWidth(c.n));
  const span = (ws: readonly number[]) =>
    ws.reduce((a, b) => a + b, 0) + Math.max(0, ws.length - 1) * CHIP_GAP;
  const budget = width - chipFloor;
  // Un conteggio solo non si arrotola MAI: un rollup di uno è lo stesso numero
  // con un glifo che dice meno. E se non ci sta nemmeno quello, si mostra
  // comunque — il segnale primario può stringersi, non sparire in silenzio.
  if (counts.length === 1 || span(widths) <= budget) return { shown: [...counts], rolled: null };
  const rolledFrom = (k: number) => {
    const rest = counts.slice(k);
    return { statuses: rest.map((c) => c.status), n: rest.reduce((a, c) => a + c.n, 0) };
  };
  for (let k = counts.length - 1; k >= 1; k--) {
    const rolled = rolledFrom(k);
    if (span([...widths.slice(0, k), countWidth(rolled.n)]) <= budget) {
      return { shown: counts.slice(0, k), rolled };
    }
  }
  return { shown: [], rolled: rolledFrom(0) };
}

/**
 * Quante pastiglie stanno in `width` pixel, e con quale disegno.
 *
 * `width === null` è «non ancora misurato», ed è DIVERSO da zero: si tace del
 * tutto, perché un «+3» che compare e sparisce al primo layout è peggio del
 * vuoto di un frame. `width === 0` invece è una misura vera — la riga non ha
 * spazio — e va ANNUNCIATA: `hidden` vale tutte, così il «+N» dice che manca
 * qualcosa invece di lasciar sparire dei progetti in silenzio. (Sostituire
 * questa distinzione con un `if (w > 0) setWidth(w)` sarebbe un bug travestito
 * da fix: la larghezza resterebbe appiccicata all'ultimo valore buono e la
 * sparizione tornerebbe muta — è esattamente ciò che BOARD-14 blocca.)
 *
 * Due passaggi per modo, e il secondo è quello che di solito manca: se non ci
 * stanno tutte serve spazio anche per il «+N» che dichiara le mancanti, quindi
 * il conteggio va rifatto con quel posto già tolto. Senza, l'ultima pastiglia e
 * il «+N» si contendono gli stessi pixel e uno dei due esce dal bordo. Qui non
 * innesca nessuna retroazione: è aritmetica su una larghezza che NON dipende da
 * cosa ci disegniamo dentro (il contenitore misurato è elastico e con
 * `min-w-0`), al contrario di un «+N» che entra ed esce dal flusso e cambia la
 * misura che lo ha deciso.
 *
 * I gradini si provano nell'ordine di {@link CHIP_MODES}, dal più ricco: si
 * scende solo quando del gradino corrente non entra NEMMENO UNA pastiglia. Il
 * gradino è lo stesso per tutte quelle mostrate — mescolarli darebbe una riga in
 * cui la prima pastiglia dice una cosa e la seconda un'altra.
 */
export function fitProjectChips<T>(width: number | null, chips: readonly T[]): FittedChips<T> {
  const zero = (mode: ChipMode = CHIP_MODES[0]!.mode) => ({ shown: [] as T[], hidden: 0, mode });
  if (chips.length === 0) return zero();
  if (width === null) return zero();
  const tryMode = (mode: ChipMode, cw: number): FittedChips<T> | null => {
    const span = (n: number) => n * cw + (n - 1) * CHIP_GAP;
    let n = chips.length;
    while (n > 0 && span(n) > width) n--;
    if (n === chips.length) return { shown: [...chips], hidden: 0, mode };
    while (n > 0 && span(n) + CHIP_GAP + MORE_W > width) n--;
    return n > 0 ? { shown: chips.slice(0, n), hidden: chips.length - n, mode } : null;
  };
  for (const { mode, w } of CHIP_MODES) {
    const fitted = tryMode(mode, w);
    if (fitted) return fitted;
  }
  return { shown: [], hidden: chips.length, mode: CHIP_MODES[0]!.mode };
}

export interface FittedBoardRow {
  chips: FittedChips<BoardProjectChip>;
  counts: FittedCounts;
}

/**
 * LA RIPARTIZIONE DELLA RIGA, in una funzione sola.
 *
 * `width` è lo spazio ELASTICO della riga — quello che resta dopo il glifo, la
 * parola «Board» e i loro spazi — e vale `null` finché non è stato misurato:
 * in quel primo istante i conteggi si disegnano per intero (sono il segnale
 * primario e non dipendono da una misura) e le pastiglie tacciono.
 */
export function fitBoardRow(
  width: number | null,
  chips: readonly BoardProjectChip[],
  counts: readonly BoardCount[],
): FittedBoardRow {
  if (width === null) {
    return { chips: { shown: [], hidden: 0, mode: CHIP_MODES[0]!.mode }, counts: { shown: [...counts], rolled: null } };
  }
  // Il pavimento vale solo se c'è davvero qualche progetto da mostrare: senza
  // pastiglie da disegnare, riservare spazio per una sarebbe un buco. E deve
  // comprendere il «+N», quando ce ne sarà uno: un pavimento da sola pastiglia
  // lascia passare il caso in cui la pastiglia ci starebbe ma il suo ritaglio
  // dichiarato no — e `fitProjectChips`, che non disegna mai una pastiglia
  // senza poter dire quante ne mancano, risponde ZERO. È il difetto di prima
  // spostato di due pixel, non risolto.
  const chipFloor = chips.length > 0
    ? CHIP_W_ICON + CHIP_GAP + (chips.length > 1 ? MORE_W + CHIP_GAP : 0)
    : 0;
  const fittedCounts = fitStatusCounts(width, chipFloor, counts);
  const used = countsSpan(fittedCounts);
  const chipSpace = Math.max(0, width - (used > 0 ? used + CHIP_GAP : 0));
  return { chips: fitProjectChips(chipSpace, chips), counts: fittedCounts };
}
