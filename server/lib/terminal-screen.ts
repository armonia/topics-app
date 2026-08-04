/**
 * Lo SCHERMO di un terminale, non il suo scrollback.
 *
 * PERCHÉ SERVE. `GET /…/buffer` restituisce il ring buffer grezzo: gli ultimi
 * ~100 KB di byte che la PTY ha scritto. Su un programma che ridisegna IN
 * PLACE — un menu con le frecce, una barra di avanzamento, qualunque TUI — quei
 * byte non dicono cosa c'è a schermo: dicono cosa è stato *scritto*, comprese
 * tutte le versioni precedenti della stessa riga. Un agente che legge il buffer
 * grezzo non sa quale voce è evidenziata, né se il tasto che ha premuto è
 * arrivato. Vede la storia, non lo stato.
 *
 * COME. Si rigioca il flusso su un emulatore headless (`@xterm/headless`, la
 * stessa famiglia che il client usa a schermo) e si legge la griglia risultante.
 * Il parser VT non lo scriviamo noi: le sequenze di controllo sono un formato
 * ostile — cursore, cancellazioni parziali, regioni di scorrimento, larghezza
 * doppia — e una copia fatta a mano sarebbe giusta sui casi provati e sbagliata
 * sugli altri, in silenzio.
 *
 * DOVE VIVE. Nel SERVER, non nei bridge. La proposta originale prevedeva di
 * emulare due volte — una nel bridge Node, una in quello Rust — ma il server ha
 * già il flusso di byte di entrambi (`getTerminalBuffer` → `requestBuffer`),
 * quindi una implementazione sola copre tutti e due i gusci. Due copie dello
 * stesso emulatore sarebbero anche due occasioni di divergere.
 *
 * COSTO. Un emulatore usa-e-getta per chiamata, alimentato con al massimo il
 * ring buffer. Non c'è stato da mantenere fra una lettura e l'altra: lo schermo
 * è una funzione del flusso, e ricalcolarlo è più onesto che tenerne una copia
 * che può sfasarsi.
 */
import { Terminal } from "@xterm/headless";

export interface TerminalScreen {
  /** Le righe visibili, dalla prima all'ultima, senza spazi in coda. */
  lines: string[];
  /** Dove sta il cursore adesso: `row`/`col` a base 0, relativi al viewport. */
  cursor: { row: number; col: number };
  cols: number;
  rows: number;
}

export interface RenderScreenOpts {
  cols?: number;
  rows?: number;
  /**
   * Taglia le righe vuote in coda. Uno schermo di 30 righe con 4 di contenuto
   * restituirebbe 26 righe vuote: rumore per chi legge, e per un agente sono
   * token. Le righe vuote IN MEZZO restano — lì lo spazio è informazione.
   */
  trimTrailingBlank?: boolean;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * Rigioca `stream` su un terminale headless e restituisce lo schermo risultante.
 *
 * `cols`/`rows` devono essere quelli della sessione vera: rigiocare a una
 * larghezza diversa manda a capo dove il programma non l'aveva fatto, e il
 * risultato somiglia allo schermo senza esserlo.
 */
export async function renderScreen(
  stream: string,
  opts: RenderScreenOpts = {},
): Promise<TerminalScreen> {
  const cols = opts.cols && opts.cols > 0 ? opts.cols : DEFAULT_COLS;
  const rows = opts.rows && opts.rows > 0 ? opts.rows : DEFAULT_ROWS;

  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  try {
    // `write` è asincrona (l'emulatore fa il parsing a chunk): senza aspettare
    // la callback si leggerebbe una griglia a metà — e il difetto sarebbe
    // intermittente, cioè il peggiore da diagnosticare.
    await new Promise<void>((resolve) => term.write(stream, resolve));

    const buf = term.buffer.active;
    const lines: string[] = [];
    // `baseY` è la prima riga del VIEWPORT: con scrollback 0 è 0, ma leggerlo
    // invece di assumerlo tiene la funzione corretta se un domani lo si alza.
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    const out = opts.trimTrailingBlank === false ? lines : trimTrailingBlank(lines);
    return {
      lines: out,
      cursor: { row: buf.cursorY, col: buf.cursorX },
      cols,
      rows,
    };
  } finally {
    // Un emulatore non disposto trattiene i suoi buffer: qui se ne crea uno per
    // chiamata, quindi dimenticarlo sarebbe una perdita per ogni lettura.
    try { term.dispose(); } catch { /* già disposto */ }
  }
}

/** Toglie SOLO le righe vuote finali. Quelle in mezzo sono contenuto. */
export function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}

/** Lo schermo come testo, una riga per riga. Comodo per chi lo mette in un
 *  prompt: è già ciò che vedrebbe un umano. */
export function screenToText(screen: TerminalScreen): string {
  return screen.lines.join("\n");
}
