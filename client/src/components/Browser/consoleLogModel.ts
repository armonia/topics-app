/**
 * La console della pane browser: chi entra nella lista, come si raggruppa, come
 * si legge l'ora, cosa finisce negli appunti. Senza React intorno.
 *
 * La tendina era un elenco e basta: tutte le righe, nessun filtro, nessuna
 * ricerca, e un `console.log` dentro un `requestAnimationFrame` la riempiva di
 * cinquecento copie della stessa riga finche' l'errore che stavi cercando usciva
 * dal buffer. Le regole che la rendono leggibile sono poche e possono sbagliare
 * in silenzio (un conteggio che non torna, un raggruppamento che mangia una riga
 * diversa, un'ora che salta di un'ora al cambio di fuso), quindi stanno qui
 * dentro come `downloadsModel.ts` e `findInPageModel.ts`: pure, e testabili
 * senza montare una webview nativa.
 *
 * Contratto:
 *  - i CONTEGGI dei chip si misurano sulle voci che passano la RICERCA, non sul
 *    buffer intero. Servono a dire «con questo testo ci sono 3 errori e nessun
 *    warning», che e' l'unica lettura utile mentre stai cercando qualcosa; un
 *    chip che continua a dire 12 mentre a schermo ce n'e' una sola sarebbe un
 *    numero che descrive un elenco che non stai guardando;
 *  - il RAGGRUPPAMENTO avviene DOPO il filtro, sulle righe che l'utente vede
 *    davvero. Il badge «xN» conta le ripetizioni che altrimenti leggeresti una
 *    di fila all'altra sullo schermo, e questa e' la sua definizione: due voci
 *    identiche separate solo da una riga filtrata via sono, a schermo,
 *    consecutive;
 *  - la riga raggruppata tiene l'ora e la posizione della PRIMA occorrenza. Il
 *    contatore che cresce sotto un orario che si sposta racconterebbe due
 *    tempi diversi nella stessa riga, e l'elenco e' ordinato per il primo;
 *  - la chiave del gruppo e' livello + testo, e non la sorgente: due `error`
 *    identici da due file diversi sono lo stesso guasto ripetuto, ed e' quello
 *    che si vuole vedere collassato.
 */
import type { BrowserConsoleEntry } from './browserDevTypes';

/** Il livello selezionato nei chip. `info` tiene dentro anche i `log`: sono la
 *  stessa cosa per chi guarda, e due chip separati per «quasi tutto» e «tutto
 *  il resto» sarebbero due modi di dire «niente di grave». */
export type ConsoleFilter = 'all' | 'error' | 'warn' | 'info' | 'debug';

/** I chip, nell'ordine in cui si leggono: prima tutto, poi la gravita' che
 *  scende. L'etichetta sta qui e non nel componente perche' l'ordine e i
 *  livelli sono la stessa decisione. */
export const CONSOLE_FILTERS: readonly { id: ConsoleFilter; label: string }[] = [
  { id: 'all', label: 'Tutti' },
  { id: 'error', label: 'Errori' },
  { id: 'warn', label: 'Warning' },
  { id: 'info', label: 'Info+Log' },
  { id: 'debug', label: 'Debug' },
];

/** Una riga come finisce a schermo: una voce, oppure N voci consecutive
 *  identiche collassate in una. */
export interface ConsoleLogRow {
  /** Quello della prima occorrenza: chiave React stabile finche' il gruppo
   *  cresce in coda. */
  id: number;
  level: BrowserConsoleEntry['level'];
  text: string;
  source?: string;
  /** Epoch ms della prima occorrenza. 0 = voce senza ora (vedi `consoleTime`). */
  at: number;
  /** Quante voci ha inghiottito. Sempre >= 1; il badge si mostra da 2 in su. */
  count: number;
}

/** Quante voci per chip, dopo la ricerca. Le chiavi sono quelle dei chip, cosi'
 *  il componente non deve tradurre niente. */
export type ConsoleCounts = Record<ConsoleFilter, number>;

export interface ConsoleView {
  rows: ConsoleLogRow[];
  counts: ConsoleCounts;
}

/** Il chip sotto cui cade un livello. `log` e `info` finiscono insieme. */
function bucketOf(level: BrowserConsoleEntry['level']): Exclude<ConsoleFilter, 'all'> {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  if (level === 'debug') return 'debug';
  return 'info';
}

/**
 * `hh:mm:ss` locale, 24h, zeri davanti.
 *
 * Il segnaposto per un'ora che non c'e' e' `--:--:--` e non una stringa vuota:
 * la colonna e' a larghezza fissa, e una cella vuota sposterebbe il testo di
 * quella riga rispetto a tutte le altre. Una voce senza ora esiste davvero, ed
 * e' quella arrivata da un buffer riempito prima che il campo esistesse.
 */
export function consoleTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '--:--:--';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Vero se la voce contiene il testo cercato, senza distinguere maiuscole.
 *
 * La ricerca si TAGLIA agli estremi: un incolla si porta dietro uno spazio, e
 * una console che di colpo non trova piu' niente per un carattere invisibile
 * sembra rotta. Dentro la stringa gli spazi contano, quindi «type error» resta
 * una ricerca diversa da «typeerror».
 */
function matchesQuery(e: { text: string; source?: string }, needle: string): boolean {
  if (!needle) return true;
  return e.text.toLowerCase().includes(needle) || (e.source ?? '').toLowerCase().includes(needle);
}

/** Le voci consecutive identiche (livello + testo) diventano una riga sola. */
function groupConsecutive(entries: readonly BrowserConsoleEntry[]): ConsoleLogRow[] {
  const rows: ConsoleLogRow[] = [];
  for (const e of entries) {
    const last = rows[rows.length - 1];
    if (last && last.level === e.level && last.text === e.text) {
      last.count += 1;
      continue;
    }
    rows.push({
      id: e.id,
      level: e.level,
      text: e.text,
      source: e.source,
      at: e.at,
      count: 1,
    });
  }
  return rows;
}

/**
 * Le voci grezze -> quello che il pannello disegna: le righe e i numeri dei
 * chip, in un giro solo perche' sono la stessa lettura del buffer.
 */
export function buildConsoleView(
  entries: readonly BrowserConsoleEntry[],
  filter: ConsoleFilter,
  query: string,
): ConsoleView {
  const needle = query.trim().toLowerCase();
  const searched = needle ? entries.filter((e) => matchesQuery(e, needle)) : entries;

  const counts: ConsoleCounts = { all: searched.length, error: 0, warn: 0, info: 0, debug: 0 };
  for (const e of searched) counts[bucketOf(e.level)] += 1;

  const leveled = filter === 'all' ? searched : searched.filter((e) => bucketOf(e.level) === filter);
  return { rows: groupConsecutive(leveled), counts };
}

/**
 * Le righe VISIBILI come testo da incollare in una segnalazione.
 *
 * `hh:mm:ss [level] testo (source)`, la sorgente solo se c'e' (delle parentesi
 * vuote sarebbero rumore) e il moltiplicatore in coda solo se il gruppo ne ha
 * mangiate piu' di una: cosi' la forma della riga comune resta esattamente
 * quella dichiarata, e chi legge non deve imparare due formati.
 */
export function formatConsoleRows(rows: readonly ConsoleLogRow[]): string {
  return rows
    .map((r) => {
      const src = r.source ? ` (${r.source})` : '';
      const times = r.count > 1 ? ` x${r.count}` : '';
      return `${consoleTime(r.at)} [${r.level}] ${r.text}${src}${times}`;
    })
    .join('\n');
}
