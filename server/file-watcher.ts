/**
 * Watcher del filesystem di progetto — l'albero dei file smette di essere una
 * fotografia.
 *
 * ── Perché ──────────────────────────────────────────────────────────────────
 * `loadFiles` girava al montaggio, sul bottone Aggiorna, e dopo le mutazioni
 * fatte dall'Explorer STESSO. In un'app il cui mestiere è far lavorare agenti
 * sul filesystem, questo vuol dire che ogni file creato da un agente era
 * invisibile finché non premevi Aggiorna. Ed era asimmetrico in modo visibile:
 * nella stessa sidebar i numeri di git si muovevano in tempo reale — c'è un
 * watcher su `.git` da sempre — mentre l'albero accanto restava fermo.
 *
 * ── Cosa manda ──────────────────────────────────────────────────────────────
 * Solo `{ type: "files:changed", projectPath }`, senza payload: il client
 * ricarica il pezzo che gli serve. Spedire l'albero significherebbe ricalcolare
 * e trasmettere migliaia di voci a ogni salvataggio, e il client dovrebbe
 * comunque riconciliare le cartelle che ha caricato pigramente.
 *
 * ── Cosa NON sveglia ────────────────────────────────────────────────────────
 * Gli eventi dentro le cartelle pesanti (`node_modules`, `dist`, `.git`, …)
 * vengono scartati PRIMA del debounce. Senza, un `bun run build` o un
 * `npm install` produrrebbero decine di migliaia di eventi al secondo, ognuno
 * dei quali riarma il timer: il messaggio non partirebbe mai durante il build
 * e partirebbe a raffica subito dopo.
 */
import { watch } from "fs";
import type { AppContext } from "./types";
import { refreshGitStatus } from "./git-watcher";

const DEBOUNCE_MS = 300;
/** Tetto ai progetti osservati insieme: ogni watcher ricorsivo costa. */
const MAX_WATCHERS = 24;

/**
 * Segmenti di path che non meritano un evento. Sono le stesse cartelle che
 * l'elenco dei file salta: se non si vedono, non c'è niente da aggiornare.
 */
const NOISY = new Set([
  ".git", "node_modules", "dist", "build", ".next", "target", "coverage",
  ".turbo", ".vercel", ".output", ".cache", ".nyc_output", ".parcel-cache",
  "__pycache__", ".DS_Store",
]);

const watchers = new Map<string, { close: () => void }>();

function isNoisy(rel: string | null): boolean {
  if (!rel) return false;
  for (const seg of rel.split(/[\\/]/)) {
    if (NOISY.has(seg)) return true;
  }
  return false;
}

/**
 * Comincia a osservare `projectPath`. Idempotente: chiamarla di nuovo per lo
 * stesso path non fa niente, così la si può chiamare a ogni `/api/files` —
 * esattamente come `watchGitDir` fa da `/api/git/status`.
 */
export function watchProjectFiles(projectPath: string, ctx: AppContext): void {
  if (watchers.has(projectPath)) return;
  if (watchers.size >= MAX_WATCHERS) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const onChange = (_event: string, filename: string | Buffer | null) => {
    if (closed) return;
    const rel = filename == null ? null : filename.toString();
    if (isNoisy(rel)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      ctx.broadcastToAll({ type: "files:changed", projectPath });
      // E anche lo stato git: il watcher di `.git` guarda `index`, `HEAD` e
      // `refs`, cioè le operazioni git. Salvare un file non tocca niente di
      // quello, quindi una modifica fatta da un editor esterno, da un agente o
      // da un terminale non faceva scattare nessun push — e con il canale WS
      // attivo il poll del client è a 60 secondi.
      void refreshGitStatus(projectPath, ctx);
    }, DEBOUNCE_MS);
  };

  try {
    // `recursive` non esiste su tutti i sistemi (storicamente non su Linux):
    // se non c'è, si rinuncia in silenzio invece di far cadere la richiesta —
    // l'albero torna a essere una fotografia, che è com'era prima.
    const w = watch(projectPath, { recursive: true }, onChange);
    w.on("error", () => unwatchProjectFiles(projectPath));
    watchers.set(projectPath, {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        try { w.close(); } catch {}
      },
    });
  } catch {
    // Nessun watcher: nessun `files:changed`. Il bottone Aggiorna resta.
  }
}

export function unwatchProjectFiles(projectPath: string): void {
  const w = watchers.get(projectPath);
  if (w) {
    w.close();
    watchers.delete(projectPath);
  }
}

/** Solo per i test e per la diagnostica. */
export function watchedProjectCount(): number {
  return watchers.size;
}
