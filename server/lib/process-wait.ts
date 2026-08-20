/**
 * Aspettare la fine di qualcosa, invece di sondarla.
 *
 * Un agente che lancia un build, una suite o un dev server aveva un solo modo
 * di sapere com'e' finita: richiamare `read_process_output` a ripetizione.
 * Ogni giro e' un turno del modello, e un turno costa contesto: la stessa coda
 * di log riletta cinque volte per scoprire che il processo stava ancora
 * partendo. Qui l'attesa avviene UNA volta, lato server, e torna solo
 * l'output nuovo con il motivo per cui si e' fermata.
 *
 * Il modulo e' diviso in due:
 *   · `awaitProcess` — il ciclo, con orologio e attesa iniettabili, cosi' il
 *     comportamento (esce / combacia / scade) si prova senza far passare
 *     davvero due minuti;
 *   · il REGISTRO delle attese — chi sta aspettando cosa e da quando. Serve
 *     all'interfaccia: un'attesa che nessuno vede e' indistinguibile da un
 *     agente piantato, ed e' esattamente il dubbio che questa funzione deve
 *     togliere.
 */

/** Perche' l'attesa si e' fermata. */
export type WaitReason = "exit" | "match" | "timeout";

export const WAIT_DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Il tetto non e' un capriccio di prudenza: la chiamata viaggia su una fetch
 * del bridge MCP, e le implementazioni ne chiudono una ferma da troppo tempo
 * (300s e' la soglia tipica sugli header). Stare sotto vuol dire che a scadere
 * e' SEMPRE il nostro timer, che risponde con un verdetto leggibile, e mai il
 * trasporto, che risponde con un errore di rete che non dice niente.
 */
export const WAIT_MAX_TIMEOUT_MS = 240_000;
export const WAIT_POLL_MS = 250;

/** Il timeout chiesto dal chiamante, riportato dentro i limiti. */
export function clampWaitTimeout(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 1_000), WAIT_MAX_TIMEOUT_MS);
}

/**
 * Il motivo per cui `until` e' una stringa e non una regexp gia' pronta: chi la
 * scrive e' un modello, dall'altra parte di un canale JSON. Una regexp storta
 * deve tornare un errore che si legge, non far esplodere la rotta.
 */
export function compileUntil(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== "string" || !pattern) return undefined;
  try {
    return new RegExp(pattern, "i");
  } catch (err: any) {
    throw new Error(`until: not a valid regular expression (${err?.message ?? "error"})`);
  }
}

/** Il pezzo di log non ancora visto, cosi' come lo serve il ring buffer. */
export interface WaitSlice {
  output: string;
  /** L'ultima riga senza `\n`: si guarda, non si accumula (tornera' intera). */
  pending?: string;
  offset: number;
  done: boolean;
  status: string;
  exitCode?: number;
  truncatedLines?: number;
}

export interface WaitOutcome {
  reason: WaitReason;
  output: string;
  offset: number;
  status: string;
  exitCode?: number;
  waitedMs: number;
  truncatedLines: number;
}

/**
 * Il ciclo. Legge dal cursore, accumula, e si ferma alla prima delle tre:
 * il processo esce, una riga combacia con `until`, scade il tempo.
 *
 * L'uscita si legge SEMPRE con un giro in piu': `proc.exited` puo' risolversi
 * prima che i lettori di stdout abbiano svuotato l'ultimo chunk, e la riga che
 * conta — quella con l'errore — e' quasi sempre l'ultima. Tornare al primo
 * `done` significava consegnare un log troncato proprio dove serviva.
 */
export async function awaitProcess(opts: {
  read: (offset: number) => WaitSlice;
  offset?: number;
  until?: RegExp;
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WaitOutcome> {
  const pollMs = opts.pollMs ?? WAIT_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const started = now();

  let cursor = opts.offset ?? 0;
  let acc = "";
  let truncated = 0;
  let drained = false;

  for (;;) {
    const slice = opts.read(cursor);
    cursor = slice.offset;
    acc += slice.output;
    truncated += slice.truncatedLines ?? 0;

    const finish = (reason: WaitReason, extra = ""): WaitOutcome => ({
      reason,
      output: acc + extra,
      offset: cursor,
      status: slice.status,
      ...(slice.exitCode !== undefined && slice.exitCode !== null ? { exitCode: slice.exitCode } : {}),
      waitedMs: now() - started,
      truncatedLines: truncated,
    });

    if (opts.until) {
      // La riga a meta' entra nel confronto ma non nell'accumulo: un dev server
      // che stampa «ready» senza andare a capo altrimenti non si vedrebbe
      // finche' non stampa qualcos'altro, cioe' potenzialmente mai.
      const pending = slice.pending ?? "";
      if (opts.until.test(acc + pending)) return finish("match", pending);
    }

    if (slice.done) {
      if (!drained) {
        drained = true;
        await sleep(pollMs);
        continue;
      }
      return finish("exit", slice.pending ?? "");
    }

    if (now() - started >= opts.timeoutMs) return finish("timeout", slice.pending ?? "");
    await sleep(pollMs);
  }
}

// ── Registro delle attese (l'interfaccia) ───────────────────────────────────

export interface ProcessWatch {
  watchId: string;
  processId: string;
  /** Chi aspetta: il titolo della topic o del task, per la riga del pannello. */
  label: string;
  /** Il motivo per cui si aspetta, quando non e' semplicemente «la fine». */
  until?: string;
  startedAt: string;
  expiresAt: string;
}

/** Cio' che la lista dei processi porta al client per ogni riga. */
export interface ProcessWatchInfo {
  label: string;
  since: string;
  until?: string;
}

const watches = new Map<string, ProcessWatch>();
let watchSeq = 0;

/** Apre un'attesa e torna la chiusura: si usa in un `finally`, sempre. */
export function openWatch(entry: {
  processId: string;
  label: string;
  until?: string;
  timeoutMs: number;
  now?: () => number;
}): { watch: ProcessWatch; close: () => void } {
  const now = entry.now ?? Date.now;
  const t = now();
  const watch: ProcessWatch = {
    watchId: `w${++watchSeq}`,
    processId: entry.processId,
    label: entry.label,
    ...(entry.until ? { until: entry.until } : {}),
    startedAt: new Date(t).toISOString(),
    expiresAt: new Date(t + entry.timeoutMs).toISOString(),
  };
  watches.set(watch.watchId, watch);
  return { watch, close: () => { watches.delete(watch.watchId); } };
}

/** Le attese aperte su un processo, per la spia sulla sua riga. */
export function watchesForProcess(processId: string): ProcessWatchInfo[] {
  const out: ProcessWatchInfo[] = [];
  for (const w of watches.values()) {
    if (w.processId !== processId) continue;
    out.push({ label: w.label, since: w.startedAt, ...(w.until ? { until: w.until } : {}) });
  }
  return out;
}

/** Quante attese sono aperte in tutto. Usato dai test e dalle diagnostiche. */
export function countWatches(): number {
  return watches.size;
}
