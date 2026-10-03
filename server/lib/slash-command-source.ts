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
import { readCliCommandList } from "../providers/claude/events";

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

/**
 * The skills Claude Code has switched OFF (`skillOverrides: { name: "off" }`),
 * read from the same settings the CLI reads: the user's, the project's and the
 * project's local ones (`--setting-sources user,project,local`,
 * `server/providers/claude/args.ts`), later ones winning.
 *
 * The menu used to offer them anyway: ten on the Mac where this was measured,
 * and typing one was a paid turn in which the model said it could not run it.
 */
export function disabledSkillNames(home = homedir(), cwd = process.cwd()): Set<string> {
  const merged: Record<string, unknown> = {};
  const files = [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  for (const file of files) {
    try {
      const overrides = (JSON.parse(readFileSync(file, "utf-8")) as { skillOverrides?: unknown }).skillOverrides;
      if (overrides && typeof overrides === "object") Object.assign(merged, overrides);
    } catch { /* absent or unreadable: nothing switched off there */ }
  }
  return new Set(Object.entries(merged).filter(([, v]) => v === "off").map(([k]) => k));
}

/**
 * THE CLI'S OWN LIST, as it says it at the start of every turn.
 *
 * Disk discovery sees the folders Topics knows about, and that is not all the
 * CLI expands: its BUNDLED skills (`/simplify`, `/code-review`, `/loop`,
 * `/claude-api`...) live inside the binary, and a plugin's skills under the
 * plugin cache, un-namespaced when the plugin says so. For those the disk says
 * «no», and the first turn kept the broken shape (context in front, skill never
 * expanded). The CLI names every command it will expand in the `slash_commands`
 * field of its `system/init` line, so that list is the first answer and the
 * disk the fallback.
 *
 * Recorded per session (`recordCliSlashCommands`, called by the claude-code
 * provider on each init, the reattach replay included), in memory: it is
 * rebuilt by the first turn of any session after a restart. The FIRST turn of
 * a session is exactly the one with no init of its own yet, so it reads the
 * list most recently reported by any session: the bundled and the user's
 * plugin skills are the same binary's for every chat. A project's own
 * `.claude/skills` from another session can ride along in that borrowed list;
 * the cost is a bare `/name` that the CLI then reports as unknown, the same
 * answer it gives in a terminal.
 */
const cliCommandsBySession = new Map<string, ReadonlySet<string>>();
let latestCliCommands: ReadonlySet<string> | null = null;

/**
 * THE ENGINE'S OWN LIST, AS THE MENU READS IT (CMDUI-01).
 *
 * The same lines, kept with what the menu needs: the description, the hint,
 * the aliases and whether the name is the CLI's own (`commands_changed` says
 * `builtin`), for Claude Code; the `available_commands_update` of an ACP agent
 * (jcode, gemini) for those. Per session, and remembered per project and per
 * engine: a chat that has not started its CLI yet borrows the last list seen
 * for its project, then for its engine. Never a process started just to ask:
 * a CLI is hundreds of MB on a machine short of RAM. In memory only; the first
 * turn after a restart rebuilds it.
 */
export interface EngineCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin?: boolean;
  aliases?: string[];
}
const engineBySession = new Map<string, EngineCommand[]>();
const engineByProject = new Map<string, EngineCommand[]>();
const engineByProvider = new Map<string, EngineCommand[]>();
const projectKey = (provider: string, projectPath: string) => `${provider}\u0000${projectPath}`;

/**
 * Store an engine's list for `sessionKey` (and its project and engine). A
 * list WITHOUT descriptions (Claude Code's `init`) keeps the descriptions an
 * earlier `commands_changed` of the same session gave, name by name.
 */
export function recordEngineCommands(
  sessionKey: string,
  commands: readonly EngineCommand[],
  ctx: { provider: string; projectPath?: string | null },
): void {
  const valid = commands.filter((c) => isValidSlashCommandName(c.name));
  if (valid.length === 0) return;
  const before = new Map((engineBySession.get(sessionKey) ?? []).map((c) => [c.name, c] as const));
  const merged = valid.map((c) => {
    const old = before.get(c.name);
    return old && !c.description ? { ...old, ...c, description: old.description, argumentHint: c.argumentHint ?? old.argumentHint, builtin: c.builtin ?? old.builtin, aliases: c.aliases ?? old.aliases } : { ...c };
  });
  engineBySession.set(sessionKey, merged);
  if (ctx.projectPath) engineByProject.set(projectKey(ctx.provider, ctx.projectPath), merged);
  engineByProvider.set(ctx.provider, merged);
}

/**
 * The list the menu shows for a chat: its session's, else the last one seen
 * for its project on the same engine, else the last one of the engine. Null
 * when the engine has said nothing since the server started.
 */
export function engineCommandsFor(q: { sessionKey?: string | null; provider: string; projectPath?: string | null }): EngineCommand[] | null {
  if (q.sessionKey) {
    const own = engineBySession.get(q.sessionKey);
    if (own) return own;
  }
  if (q.projectPath) {
    const ofProject = engineByProject.get(projectKey(q.provider, q.projectPath));
    if (ofProject) return ofProject;
  }
  return engineByProvider.get(q.provider) ?? null;
}

/**
 * Store a Claude CLI line for `sessionKey`: the names of a `system/init`
 * (`slash_commands`) or the entries of a `system/commands_changed`. Anything
 * else, or a line with no list, is ignored. `cwd` is the folder the CLI says
 * it runs in (the init's own `cwd`), the project the list is remembered for.
 */
export function recordCliSlashCommands(sessionKey: string, line: unknown): void {
  const list = readCliCommandList(line);
  if (!list) return;
  const names = new Set(list.map((c) => c.name).filter(isValidSlashCommandName));
  if (names.size === 0) return;
  cliCommandsBySession.set(sessionKey, names);
  latestCliCommands = names;
  const cwd = (line as { cwd?: unknown }).cwd;
  recordEngineCommands(sessionKey, list, { provider: "claude-code", projectPath: typeof cwd === "string" ? cwd : null });
}

/** Forget every recorded list. For tests. */
export function resetCliSlashCommands(): void {
  cliCommandsBySession.clear();
  latestCliCommands = null;
  engineBySession.clear();
  engineByProject.clear();
  engineByProvider.clear();
}

/**
 * Whether `/name` is a command or skill the Claude CLI will expand.
 *
 * First the CLI's own word (`recordCliSlashCommands`): the list of the session
 * `cliSessionKey`, or, before that session has said anything, the latest list
 * any session reported. Only for a claude-code session: no other provider
 * expands the CLI's bundled skills, so a caller for another provider passes no
 * key and only the disk answers.
 *
 * Then the disk: the same folders as `readSlashCommandSource`, plus the
 * project's own `.claude/skills` under `cwd` (the CLI loads those too). A
 * namespaced name (`opsx:propose`, `plugin:skill`) counts as a command by its
 * shape: a pasted path never has a colon in its first segment.
 *
 * It answers one question for the context adapter: does this message have to
 * reach the CLI bare? A wrong «no» keeps today's behaviour (context in front),
 * a wrong «yes» would send a pasted path like `/tmp to check` bare, so only
 * names that exist say yes.
 */
export function isKnownSlashCommand(
  name: string,
  opts: { home?: string; cwd?: string | null; cliSessionKey?: string | null } = {},
): boolean {
  if (!isValidSlashCommandName(name)) return false;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? null;
  // A skill switched off in `skillOverrides` is not expanded by the CLI: a
  // typed `/name` is prose there, and must keep its context in front.
  if (disabledSkillNames(home, cwd ?? home).has(name)) return false;
  if (name.includes(":")) return true;
  if (opts.cliSessionKey) {
    const reported = cliCommandsBySession.get(opts.cliSessionKey) ?? latestCliCommands;
    if (reported?.has(name)) return true;
  }
  const files = [
    join(home, ".claude", "commands", `${name}.md`),
    ...skillDirs(home).map((dir) => join(dir, name, "SKILL.md")),
    ...(cwd
      ? [join(cwd, ".claude", "commands", `${name}.md`), join(cwd, ".claude", "skills", name, "SKILL.md")]
      : []),
  ];
  return files.some((f) => existsSync(f));
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
  const off = disabledSkillNames(home, cwd);
  for (const dir of skillDirs(home)) {
    try {
      // NIENTE `isDirectory()`: una skill puo' essere un LINK a una cartella, e
      // un link non e' una directory per `withFileTypes`. Sul Mac di Attilio 31
      // skill su 43 sparivano cosi' — l'hub condiviso `~/.agents/skills` e'
      // raggiunto da un symlink e diverse skill dentro lo sono a loro volta.
      // La domanda vera e' una sola: dentro c'e' un SKILL.md?
      for (const d of readdirSync(dir)) {
        const md = join(dir, d, "SKILL.md");
        if (existsSync(md) && !off.has(d)) add(d, md, "skill");
      }
    } catch { /* cartella assente */ }
  }
  return out;
}
