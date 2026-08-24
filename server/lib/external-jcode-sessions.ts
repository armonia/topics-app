/**
 * Il censimento delle sessioni **jcode**, nella stessa forma di quelle di
 * Claude Code.
 *
 * PERCHE' UN SECONDO SCANNER E NON UN RAMO DENTRO IL PRIMO
 * `external-claude-sessions.ts` cammina `~/.claude/projects/<cwd-codificato>/
 * <id>.jsonl` e deduce la freschezza dall'ultima riga scritta: un flusso di
 * eventi, dove «viva» significa «qualcuno ci ha scritto or ora». jcode tiene
 * UN file JSON per sessione in `~/.jcode/sessions/`, riscritto a fine turno.
 *
 * La differenza non e' cosmetica: sull'mtime, jcode risulta sempre fermo.
 * Misurato il 23/08 — 1375 sessioni su disco, ZERO con mtime negli ultimi 15
 * minuti, mentre sette processi erano vivi e uno stava macinando. Uno scanner
 * che chiedesse a jcode la stessa domanda che funziona per Claude Code
 * risponderebbe «nessuno al lavoro» ogni volta.
 *
 * Qui la freschezza si legge dove jcode la scrive davvero: `status` e
 * `last_pid`. Un pid che risponde e' una sessione viva, e non c'e' niente da
 * indovinare.
 *
 * AGGIUNGERE UN TERZO PROVIDER
 * Serve una funzione che restituisca `ExternalClaudeSession[]`, e va aggiunta
 * all'elenco in `scanAllExternalSessions`. Il contratto e' quello, non questo
 * file: chi arriva dopo non deve leggere come funziona jcode.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExternalClaudeSession } from "./external-claude-sessions";
import {
  DEFAULT_ACTIVE_MS,
  DEFAULT_WINDOW_MS,
  resolveOwningProject,
} from "./external-claude-sessions";

export interface ScanJcodeOptions {
  /** Dove jcode tiene le sessioni. Iniettabile per i test. */
  sessionsDir?: string;
  /** Adesso, in ms epoch. Iniettabile per i test. */
  now?: number;
  /** Oltre questa eta' una sessione e' `idle` anche se il processo vive. */
  activeMs?: number;
  /**
   * Oltre questa eta' la sessione non compare affatto.
   *
   * Senza, il censimento riporta ogni conversazione mai aperta: misurato,
   * 207 sessioni di cui 12 toccate nelle ultime 24 ore. Un numero cosi' non
   * risponde a «chi sta lavorando ora», risponde a «quanto ho usato jcode
   * quest'anno». Stessa finestra di Claude Code, per non avere due nozioni
   * di «recente» nella stessa riga.
   */
  windowMs?: number;
  /**
   * Il processo esiste? Di norma `process.kill(pid, 0)`, che non manda alcun
   * segnale e serve solo a chiedere «c'e' ancora?».
   *
   * Iniettabile perche' un test non puo' dipendere dai pid della macchina che
   * lo esegue.
   */
  isAlive?: (pid: number) => boolean;
  /** Quante sessioni al massimo leggere, dalla piu' recente. */
  limit?: number;
  /**
   * Le radici di progetto note, per dire A QUALE progetto appartiene un cwd.
   *
   * Senza, ogni sessione jcode resta senza progetto e sparisce da tutto cio'
   * che ragiona per progetto: il badge sulla board e la guardia del
   * dispatcher, che rifiuta di calare un agente dove qualcuno sta gia'
   * lavorando. Misurato il 23/08: 13 sessioni jcode su 13 erano orfane,
   * comprese quelle aperte dentro `topics-app` stesso.
   */
  candidatePaths?: string[];
  /** Il board id di una radice. */
  projectIdFor?: (path: string) => string;
}

function aliveByDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Due errori diversi, e confonderli fa sparire sessioni vive: ESRCH dice
    // che il processo non esiste, EPERM che esiste ma e' di un altro utente.
    // Verificato in Node: `e.code` porta la distinzione, `process.errno` non
    // esiste e restituiva sempre undefined.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Il ramo git di una directory, se e' un checkout. Best effort: un cwd che non
 *  e' un repository non e' un errore. */
function branchOf(cwd: string): string | null {
  try {
    const head = join(cwd, ".git", "HEAD");
    if (!existsSync(head)) return null;
    const raw = readFileSync(head, "utf8").trim();
    return raw.startsWith("ref: refs/heads/") ? raw.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

/**
 * Le sessioni jcode, piu' recenti per prime.
 *
 * Una sessione e' `active` quando il suo `last_pid` risponde ED e' stata
 * toccata entro `activeMs`. Il pid da solo non basta: il server jcode e'
 * condiviso, quindi lo stesso pid compare su molte sessioni e resta vivo
 * anche quando quella conversazione e' finita da ore.
 */
export function scanJcodeSessions(opts: ScanJcodeOptions = {}): ExternalClaudeSession[] {
  const dir = opts.sessionsDir ?? join(homedir(), ".jcode", "sessions");
  const now = opts.now ?? Date.now();
  const activeMs = opts.activeMs ?? DEFAULT_ACTIVE_MS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const isAlive = opts.isAlive ?? aliveByDefault;
  const limit = opts.limit ?? 200;
  const candidatePaths = opts.candidatePaths ?? [];
  const projectIdFor = opts.projectIdFor ?? (() => "");

  if (!existsSync(dir)) return [];

  let files: Array<{ path: string; mtimeMs: number }>;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const path = join(dir, f);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return { path, mtimeMs: 0 };
        }
      })
      .filter((f) => f.mtimeMs > 0 && now - f.mtimeMs <= windowMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }

  const out: ExternalClaudeSession[] = [];
  for (const f of files) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // un file a meta' scrittura non e' una sessione persa
    }

    const cwd = typeof d.working_dir === "string" ? d.working_dir : null;
    if (!cwd) continue;

    const pid = typeof d.last_pid === "number" ? d.last_pid : null;
    const stato = typeof d.status === "string" ? d.status.toLowerCase() : "";
    const age = now - f.mtimeMs;

    // Tre condizioni, tutte necessarie: jcode la dice attiva, il processo
    // risponde, e c'e' stato movimento di recente. Basta togliere la terza e
    // ogni sessione mai aperta con questo server risulta al lavoro.
    const active = stato === "active" && pid !== null && isAlive(pid) && age <= activeMs;

    const projectPath = resolveOwningProject(cwd, candidatePaths);

    out.push({
      sessionId: (typeof d.id === "string" ? d.id : f.path).replace(/^.*\//, "").replace(/\.json$/, ""),
      cwd,
      projectPath,
      projectId: projectPath ? projectIdFor(projectPath) : null,
      branch: branchOf(cwd),
      entrypoint: "jcode",
      lastActivityMs: f.mtimeMs,
      state: active ? "active" : "idle",
      transcriptPath: f.path,
    });
  }
  return out;
}
