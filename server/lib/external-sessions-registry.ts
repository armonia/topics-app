/**
 * Il censimento di **tutte** le sessioni esterne, qualunque CLI le abbia
 * aperte.
 *
 * PERCHE' ESISTE
 * Fino al 23/08 il censimento era una funzione sola, che sapeva leggere il
 * formato di Claude Code. Sembrava generico perche' si chiamava «sessioni
 * esterne», ma rispondeva a una domanda piu' stretta: «quali sessioni CLAUDE
 * CODE sono aperte». Le sessioni jcode — 1375 su disco, sette processi vivi —
 * non comparivano ne' nel totale ne' fra quelle al lavoro, e la presence
 * dichiarava «nessun agente al lavoro» mentre l'utente ne guardava tre.
 *
 * Il difetto non era «manca jcode»: era che un provider stava scritto dentro
 * la funzione invece che accanto agli altri. Qui i provider sono una LISTA, e
 * aggiungerne uno e' aggiungere una riga.
 *
 * COME AGGIUNGERE UN PROVIDER
 * Serve una funzione che restituisca `ExternalClaudeSession[]` leggendo dove
 * quella CLI tiene le sue sessioni, e una riga in `PROVIDERS`. Due regole che
 * costano care se si saltano:
 *
 *  1. **La freschezza si legge dove quella CLI la scrive.** Claude Code scrive
 *     un evento per riga, quindi l'mtime del file dice «or ora». jcode
 *     riscrive un JSON a fine turno, quindi l'mtime dice «quando ha finito»:
 *     misurato, ZERO sessioni jcode risultano toccate negli ultimi 15 minuti
 *     mentre lavorano. Copiare il criterio del vicino produce un provider che
 *     sembra sempre fermo.
 *
 *  2. **Un provider che esplode non deve spegnere gli altri.** Ogni scanner
 *     gira dentro un try: una CLI installata a meta' fa sparire le sue
 *     sessioni, non il censimento.
 */

import type { ExternalClaudeSession, ScanOptions } from "./external-claude-sessions";
import { scanExternalClaudeSessions } from "./external-claude-sessions";
import { scanCodexSessions } from "./external-codex-sessions";
import { scanJcodeSessions } from "./external-jcode-sessions";

/** Uno scanner: da opzioni comuni alle sessioni che quella CLI ha aperto. */
export interface SessionProvider {
  /** Il nome che compare nelle diagnosi. */
  name: string;
  scan: (opts: ScanOptions) => ExternalClaudeSession[];
}

export const PROVIDERS: SessionProvider[] = [
  { name: "claude-code", scan: scanExternalClaudeSessions },
  {
    name: "jcode",
    scan: (opts) =>
      scanJcodeSessions({
        now: opts.nowMs,
        activeMs: opts.activeMs,
        windowMs: opts.windowMs,
      }),
  },
  {
    name: "codex",
    scan: (opts) =>
      scanCodexSessions({
        now: opts.nowMs,
        activeMs: opts.activeMs,
        windowMs: opts.windowMs,
        knownSessionIds: opts.knownSessionIds,
        candidatePaths: opts.candidatePaths,
        projectIdFor: opts.projectIdFor,
      }),
  },
];

export interface ScanAllOptions extends ScanOptions {
  /** I provider da interrogare. Iniettabile per i test. */
  providers?: SessionProvider[];
  /** Dove finiscono gli errori di un singolo provider. */
  log?: (msg: string, err?: unknown) => void;
}

/**
 * Interroga ogni provider e restituisce l'unione, piu' recenti per prime.
 *
 * Le sessioni che Topics gia' possiede (`knownSessionIds`) restano fuori: sono
 * «esterne» solo quelle che nessun'altra superficie di Topics sta gia'
 * mostrando.
 */
export function scanAllExternalSessions(opts: ScanAllOptions): ExternalClaudeSession[] {
  const providers = opts.providers ?? PROVIDERS;
  const log = opts.log ?? (() => {});

  const out: ExternalClaudeSession[] = [];
  const visti = new Set<string>();

  for (const p of providers) {
    let trovate: ExternalClaudeSession[] = [];
    try {
      trovate = p.scan(opts);
    } catch (err) {
      // Un provider rotto costa le SUE sessioni, non tutte le altre.
      log(`scanner "${p.name}" fallito`, err);
      continue;
    }
    for (const s of trovate) {
      // Stessa sessione vista da due provider: vince chi l'ha trovata prima,
      // cioe' l'ordine di PROVIDERS. Non capita oggi, ma un id duplicato
      // gonfierebbe il conteggio in silenzio.
      if (visti.has(s.sessionId)) continue;
      if (opts.knownSessionIds.has(s.sessionId)) continue;
      visti.add(s.sessionId);
      out.push(s);
    }
  }

  return out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}
