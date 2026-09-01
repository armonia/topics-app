/**
 * Dov'è scritto un comando slash, e cosa c'è dentro.
 *
 * Serve a mostrare il CORPO di un comando che l'utente ha lanciato. Sul filo
 * quel corpo non passa — la CLI espande lo slash prima del turno, verificato —
 * ma il file esiste, ed è lo stesso da cui `/api/slash-commands` ricava già
 * nome e descrizione. La risoluzione stava inline dentro quella rotta: qui
 * diventa una funzione sola, perché adesso ha DUE chiamanti e due liste di
 * cartelle che divergono sarebbero un comando che si vede nell'elenco e non si
 * apre.
 *
 * ── Il cancello ─────────────────────────────────────────────────────────────
 * Il nome arriva dal client. Senza controllo, `../../../etc/passwd` (o un nome
 * con una barra) leggerebbe qualunque file della macchina: è esattamente la
 * classe di difetto già trovata sulle rotte dei file. Qui il nome è
 * ammesso solo se fatto di lettere, cifre, `-`, `_` e `:` — e il percorso
 * risolto deve comunque CADERE DENTRO una delle cartelle note, controllato dopo
 * la risoluzione (un link simbolico non deve poter uscire).
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export type SlashCommandKind = "command" | "skill";

/** Nomi ammessi: `recap`, `opsx:propose`, `jarvis-custom-skills:master`. */
const NAME_RE = /^[A-Za-z][\w:-]*$/;

export function isValidSlashCommandName(name: string): boolean {
  return typeof name === "string" && name.length <= 128 && NAME_RE.test(name);
}

/** Le cartelle dei comandi, in ordine di precedenza (le stesse dell'elenco). */
export function commandDirs(home = homedir(), cwd = process.cwd()): string[] {
  return [join(home, ".claude", "commands"), join(cwd, ".claude", "commands")];
}

/** Le cartelle delle skill, in ordine di precedenza. */
export function skillDirs(home = homedir()): string[] {
  return [join(home, ".claude", "skills"), join(home, "jarvis", "skills-marketplace", "skills")];
}

export interface SlashCommandSource {
  name: string;
  kind: SlashCommandKind;
  /** Il file da cui viene il corpo. */
  path: string;
  body: string;
}

/** Il percorso risolto sta davvero DENTRO una delle radici ammesse? */
function contained(file: string, roots: string[]): boolean {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  return roots.some((r) => {
    let root: string;
    try {
      root = realpathSync(r);
    } catch {
      return false;
    }
    return real === root || real.startsWith(root.endsWith("/") ? root : root + "/");
  });
}

/**
 * Il sorgente di un comando, o `null` se non esiste (o se il nome non è
 * ammesso). Precedenza: i comandi prima delle skill, e dentro ognuno l'ordine
 * delle cartelle — la stessa di `/api/slash-commands`, o l'elenco e il corpo
 * potrebbero riferirsi a due file diversi con lo stesso nome.
 */
export function readSlashCommandSource(
  name: string,
  opts: { home?: string; cwd?: string; maxBytes?: number } = {},
): SlashCommandSource | null {
  if (!isValidSlashCommandName(name)) return null;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const maxBytes = opts.maxBytes ?? 256 * 1024;

  const candidates: Array<{ file: string; kind: SlashCommandKind; roots: string[] }> = [];
  const cDirs = commandDirs(home, cwd);
  for (const dir of cDirs) candidates.push({ file: join(dir, `${name}.md`), kind: "command", roots: cDirs });
  const sDirs = skillDirs(home);
  for (const dir of sDirs) candidates.push({ file: join(dir, name, "SKILL.md"), kind: "skill", roots: sDirs });

  for (const c of candidates) {
    const file = resolve(c.file);
    if (!existsSync(file)) continue;
    if (!contained(file, c.roots)) continue;
    try {
      const body = readFileSync(file, "utf-8").slice(0, maxBytes);
      return { name, kind: c.kind, path: file, body };
    } catch {
      /* illeggibile: si prova il candidato successivo */
    }
  }
  return null;
}

/** I nomi disponibili, per l'elenco. Estratto qui perché usa le stesse radici. */
export function listSlashCommandFiles(
  opts: { home?: string; cwd?: string } = {},
): Array<{ name: string; file: string; kind: SlashCommandKind }> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const out: Array<{ name: string; file: string; kind: SlashCommandKind }> = [];
  const seen = new Set<string>();
  const add = (name: string, file: string, kind: SlashCommandKind) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, file, kind });
  };
  for (const dir of commandDirs(home, cwd)) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) add(f.slice(0, -3), join(dir, f), "command");
      }
    } catch { /* cartella assente */ }
  }
  for (const dir of skillDirs(home)) {
    try {
      // NIENTE `isDirectory()`: una skill puo' essere un LINK a una cartella, e
      // un link non e' una directory per `withFileTypes`. Sul Mac di Attilio 31
      // skill su 43 sparivano cosi' — l'hub condiviso `~/.agents/skills` e'
      // raggiunto da un symlink e diverse skill dentro lo sono a loro volta.
      // La domanda vera e' una sola: dentro c'e' un SKILL.md?
      for (const d of readdirSync(dir)) {
        const md = join(dir, d, "SKILL.md");
        if (existsSync(md)) add(d, md, "skill");
      }
    } catch { /* cartella assente */ }
  }
  return out;
}
