/**
 * Le sessioni **Codex** (la CLI dentro ChatGPT.app), per il censimento comune.
 *
 * PERCHE' UN TERZO SCANNER
 * Il registro dei provider nasce il 23/08 per far entrare jcode. Codex era il
 * caso di prova di quella promessa: misurato sulla macchina di Attilio, tre
 * sessioni toccate nelle ultime 8 ore che nessuna superficie contava. Se
 * aggiungere un provider non fosse costato poco, il registro non sarebbe
 * servito a niente.
 *
 * DOVE CODEX SOMIGLIA A CLAUDE CODE, E DOVE NO
 * Somiglia nella scrittura: un evento JSON per riga, in append. Verificato
 * prima di fidarsi, perche' e' esattamente l'assunzione che jcode aveva
 * smentito: su ogni sessione recente lo scarto fra l'mtime del file e il
 * timestamp dell'ultimo evento e' 0.0s. Quindi qui l'mtime **dice il vero** e
 * la freschezza si legge da li', senza inseguire i processi.
 *
 * Non somiglia in due punti che cambiano il codice:
 *
 *  1. **I file stanno in un albero per data** (`sessions/AAAA/MM/GG/`), non in
 *     una cartella piatta per progetto. Si scende ricorsivamente e si filtra
 *     sull'mtime del FILE: la data della cartella, sia come mtime sia come
 *     nome, non dice quando quella sessione ha parlato l'ultima volta. Il
 *     dettaglio sta su `collectFiles`, perche' entrambe le potature sembrano
 *     ovvie e sono state misurate sbagliate.
 *
 *  2. **Il cwd sta in testa, l'attivita' in coda.** La `session_meta` e' la
 *     prima riga del file e non si ripete; leggere solo la coda — come si fa
 *     con Claude Code — lascia ogni sessione senza progetto. Si legge un
 *     pezzo di testa per sapere DOVE lavora e un pezzo di coda per sapere SE
 *     lavora.
 *
 * QUANDO UNA SESSIONE E' «AL LAVORO»
 * Codex marca la fine di un turno con un evento `task_complete`. Una sessione
 * il cui ultimo evento e' quello ha finito, per quanto recente sia: resta
 * `idle` anche se il file e' stato scritto un secondo fa. Senza questa
 * lettura, chiudere un turno e restare fermi conterebbe come «al lavoro» per
 * un quarto d'ora — il difetto opposto a quello di jcode, e altrettanto
 * bugiardo.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExternalClaudeSession } from "./external-claude-sessions";
import {
  DEFAULT_ACTIVE_MS,
  DEFAULT_WINDOW_MS,
  resolveOwningProject,
} from "./external-claude-sessions";

/**
 * La testa: deve contenere per intero la `session_meta`, che e' la prima riga.
 *
 * Non e' una riga corta: porta con se' le istruzioni di base della sessione e
 * sul disco di Attilio misura ~19KB. Con una testa da 16KB il JSON arrivava
 * troncato, non parsava, e OGNI sessione Codex spariva dal censimento senza
 * un errore: 64KB per stare larghi.
 */
const HEAD_BYTES = 64 * 1024;
/** La coda: basta a contenere gli ultimi eventi di turno. */
const TAIL_BYTES = 16 * 1024;

export interface ScanCodexOptions {
  /** Dove Codex tiene le sessioni. Iniettabile per i test. */
  sessionsDir?: string;
  now?: number;
  /** Oltre questa eta' una sessione e' `idle`. */
  activeMs?: number;
  /** Oltre questa eta' la sessione non compare affatto. */
  windowMs?: number;
  /** Le sessioni che Topics gia' possiede restano fuori. */
  knownSessionIds?: ReadonlySet<string>;
  /** Radici di progetto note, per attribuire il cwd. */
  candidatePaths?: string[];
  projectIdFor?: (path: string) => string;
  /** Quante sessioni al massimo, dalla piu' recente. */
  limit?: number;
  /** Test seam. */
  fs?: CodexFs;
}

export interface CodexFs {
  /** I nomi dentro una directory, con il flag «e' una directory». */
  readdir: (dir: string) => Array<{ name: string; isDir: boolean }>;
  stat: (path: string) => { mtimeMs: number; size: number } | null;
  read: (path: string, bytes: number, from: "head" | "tail") => string;
}

const realFs: CodexFs = {
  readdir(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  stat(path) {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
  read(path, bytes, from) {
    let fd: number | null = null;
    try {
      const st = statSync(path);
      const length = Math.min(bytes, st.size);
      if (length <= 0) return "";
      const buf = Buffer.alloc(length);
      fd = openSync(path, "r");
      readSync(fd, buf, 0, length, from === "head" ? 0 : st.size - length);
      return buf.toString("utf-8");
    } catch {
      return "";
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  },
};

/**
 * I file di trascrizione sotto `dir`, dovunque siano nell'albero per data.
 *
 * NON si pota per data della cartella, ne' per mtime ne' per nome, e sono due
 * lezioni pagate:
 *  - l'mtime di una directory non si muove quando un file dentro viene
 *    riscritto, quindi la cartella di un file toccato 134 minuti fa risultava
 *    vecchia di 1900;
 *  - il nome mente in modo diverso: una sessione APERTA il 21 e scritta oggi
 *    resta archiviata sotto `2026/08/21`. Misurato: sessioni scritte 4 ore fa
 *    in cartelle di due giorni prima.
 * Si guardano tutti i file e si filtra sull'mtime del file, che e' l'unico
 * dato onesto. Costo misurato: ~11ms per 840 file, sotto la soglia di
 * qualunque cosa succeda una volta al minuto.
 */
/**
 * I file di trascrizione sotto `dir`, dovunque siano nell'albero per data.
 *
 * NON si pota per data della cartella, ne' per mtime ne' per nome, e sono due
 * lezioni pagate:
 *  - l'mtime di una directory non si muove quando un file dentro viene
 *    riscritto, quindi la cartella di un file toccato 134 minuti fa risultava
 *    vecchia di 1900;
 *  - il nome mente in modo diverso: una sessione APERTA il 21 e scritta oggi
 *    resta archiviata sotto `2026/08/21`. Misurato: sessioni scritte 4 ore fa
 *    in cartelle di due giorni prima.
 * Si guardano tutti i file e si filtra sull'mtime del file, che e' l'unico
 * dato onesto. Costo misurato: ~11ms per 840 file, sotto la soglia di
 * qualunque cosa succeda una volta al minuto.
 */
function collectFiles(
  fs: CodexFs,
  dir: string,
  now: number,
  windowMs: number,
  depth: number,
  out: Array<{ path: string; mtimeMs: number }>,
): void {
  if (depth > 4) return;
  for (const entry of fs.readdir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDir) {
      collectFiles(fs, path, now, windowMs, depth + 1, out);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    const st = fs.stat(path);
    if (!st || st.size <= 0) continue;
    if (now - st.mtimeMs > windowMs) continue;
    out.push({ path, mtimeMs: st.mtimeMs });
  }
}

/** La prima `session_meta` trovata nella testa del file. */
function parseHead(text: string): { sessionId: string | null; cwd: string | null; originator: string | null } {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      // La testa tronca l'ultima riga: normale, si prosegue.
      continue;
    }
    if (o?.type !== "session_meta") continue;
    const p = o.payload ?? {};
    return {
      sessionId: typeof p.session_id === "string" ? p.session_id : typeof p.id === "string" ? p.id : null,
      cwd: typeof p.cwd === "string" ? p.cwd : null,
      originator: typeof p.originator === "string" ? p.originator : null,
    };
  }
  return { sessionId: null, cwd: null, originator: null };
}

/**
 * L'ultimo turno e' concluso?
 *
 * Si guarda l'ultimo `event_msg` presente nella coda: se e' `task_complete`,
 * Codex ha finito di rispondere. Le righe successive (`response_item`,
 * `world_state`) non cambiano il verdetto.
 */
function tailSaysFinished(text: string): boolean {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o?.type !== "event_msg") continue;
    return o?.payload?.type === "task_complete";
  }
  return false;
}

/** Il cwd piu' recente: `turn_context` lo riporta a ogni turno. */
function tailCwd(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o?.type === "turn_context" && typeof o?.payload?.cwd === "string") return o.payload.cwd;
  }
  return null;
}

export function scanCodexSessions(opts: ScanCodexOptions = {}): ExternalClaudeSession[] {
  const dir = opts.sessionsDir ?? join(homedir(), ".codex", "sessions");
  const now = opts.now ?? Date.now();
  const activeMs = opts.activeMs ?? DEFAULT_ACTIVE_MS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const fs = opts.fs ?? realFs;
  const limit = opts.limit ?? 200;
  const known = opts.knownSessionIds ?? new Set<string>();
  const candidates = opts.candidatePaths ?? [];
  const projectIdFor = opts.projectIdFor ?? (() => "");

  const files: Array<{ path: string; mtimeMs: number }> = [];
  collectFiles(fs, dir, now, windowMs, 0, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: ExternalClaudeSession[] = [];
  for (const f of files.slice(0, limit)) {
    const head = parseHead(fs.read(f.path, HEAD_BYTES, "head"));
    // Senza id la sessione non e' indirizzabile: nessuna riga inventata.
    if (!head.sessionId) continue;
    if (known.has(head.sessionId)) continue;

    const tail = fs.read(f.path, TAIL_BYTES, "tail");
    const cwd = tailCwd(tail) ?? head.cwd ?? "";
    const projectPath = cwd ? resolveOwningProject(cwd, candidates) : null;

    const fresh = now - f.mtimeMs <= activeMs;
    const finished = tailSaysFinished(tail);

    out.push({
      sessionId: head.sessionId,
      cwd,
      projectPath,
      projectId: projectPath ? projectIdFor(projectPath) : null,
      branch: null,
      entrypoint: head.originator ?? "codex",
      lastActivityMs: f.mtimeMs,
      state: fresh && !finished ? "active" : "idle",
      transcriptPath: f.path,
    });
  }

  return out;
}
