/**
 * Where a slash command is written, and what is inside it.
 *
 * It exists to show the BODY of a command that was run. That body never travels
 * over the wire — the CLI expands the slash before the turn, verified — but the
 * file is there, and it is the same one `/api/slash-commands` already derives
 * name and description from. Resolution used to sit inline inside that route:
 * here it becomes a single function, because it now has TWO callers, and two
 * folder lists that drift apart would be a command visible in the list that
 * refuses to open.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * The name comes from the client. Unchecked, `../../../etc/passwd` (or a name
 * with a slash in it) would read any file on the machine: exactly the defect
 * class already found on the file routes. Here the name is admitted only if
 * made of letters, digits, `-`, `_` and `:` — and the resolved path must still
 * LAND INSIDE one of the known folders, checked after resolution (a symlink
 * must not be able to escape).
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
