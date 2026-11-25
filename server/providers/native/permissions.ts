/**
 * Who can do what, for the native runtime.
 *
 * THE GAP IT CLOSES. The native runtime runs the tools ITSELF: there is no CLI
 * in between applying its own rules, so the rules are these and nothing else.
 * At first `bash` and `write_file` just executed, and on a real machine, with
 * dispatched agents running on their own, that is the gap that does damage.
 *
 * IT IS NOT A SANDBOX, and that is worth saying up front because the difference
 * matters: a shell command can always get out of any perimeter (`ssh`,
 * `curl | sh`, an interpreter). What is decided here is WHAT THE AGENT MAY ASK
 * FOR, not what the operating system lets it do. It stops mistakes and
 * unfortunate initiative, not an adversary.
 *
 * THE LEVELS ARE THE ONES TOPICS ALREADY HAS (`AutonomyLevel`, on the topic),
 * because a second permission system next to the first is the sure way to end
 * up with zero working ones:
 *
 *   - `ask`        - proposes and does not touch: reading yes, writing and
 *                    executing no. It is the CLIs' "plan mode", translated.
 *   - `auto-apply` - works in the project: reads, writes, executes. Outside the
 *                    perimeter it does not go (`tools.ts` already handles that),
 *                    and DESTRUCTIVE commands stay out.
 *   - `yolo`       - everything, and it is an explicit choice by whoever sets it.
 *
 * THE DEFAULT IS `auto-apply`, not `yolo`. The CLIs historically started in
 * `bypassPermissions` and Topics inherited that default so as not to silence
 * existing chats; but that default described somebody else's program, whereas
 * here execution is ours and so is the choice. An agent that never saw a line
 * of configuration must not be able to run `rm -rf`.
 */

import { isAbsolute, relative, resolve } from "path";
import { tmpdir } from "os";
import type { AutonomyLevel } from "../../../shared/types";

export type ToolDecision =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * What THIS turn may remove or overwrite beyond the generic `/tmp` exception
 * below: its own scratch folder, and whatever it already created.
 *
 * Both fields are paths the CALLER resolved (`agent-loop.ts`, which knows the
 * tool's cwd); `decide` only compares strings, it never touches the
 * filesystem, so a target that does not exist yet is judged the same as one
 * that does.
 */
export type TurnScope = {
  tempDir?: string;
  createdPaths?: ReadonlySet<string>;
  /** The `bash` call's own cwd, to resolve a relative `rm` target against. */
  cwd?: string;
};

/** `/tmp/topics-turn-<id>`, one per call to `runAgentTurn`. */
export function turnTempDir(turnId: string): string {
  return resolve(tmpdir(), `topics-turn-${turnId}`);
}

/** True when the absolute path `abs` sits inside (or is) `dir`. */
function insideDir(abs: string, dir: string): boolean {
  const rel = relative(resolve(dir), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Il livello di chi non ha scelto. Vedi l'intestazione: non è `yolo`. */
export const DEFAULT_AUTONOMY: AutonomyLevel = "auto-apply";

/**
 * I tool che non modificano niente: leggere è sempre concesso.
 *
 * `todo_write` AND `web_fetch` BELONG HERE, and it is not a convenient
 * exception. `ask` is the plan mode: propose without touching. Writing the plan
 * IS what that mode asks for, and the list touches nothing: it exists in the
 * transcript, not on disk. Refusing it would mean the agent asked to plan
 * cannot use the planning tool.
 *
 * `web_fetch` performs a GET over http(s) and returns its text. It sends no
 * body, writes nothing, and the schemes that would leave the perimeter
 * (`file:`, `data:`) are refused in `tools.ts` BEFORE the network. Reading a
 * documentation page is exactly what proposing a plan takes, instead of
 * guessing one.
 */
const READ_ONLY = new Set(["read_file", "grep", "glob", "todo_write", "web_fetch", "tool_search"]);

// A TOOL MOUNTED FROM AN MCP SERVER IS NEVER READ-ONLY, and that is why
// READ_ONLY is an allowlist of names WE wrote rather than a heuristic. An
// inherited tool arrives as `mcp__<server>__<tool>` (see `mcp-fleet.ts`): it
// does whatever a server outside this repo decided, a name that reads like a
// search may well post something, and so it goes through the gate below like
// everything else. `ask` refuses it, `auto-apply` runs it, and the topic's
// autonomy level stays the only thing that decides.

/**
 * Comandi che non si eseguono nemmeno in `auto-apply`.
 *
 * NON è un antivirus e non prova a esserlo: chi vuole aggirarlo ci mette un
 * secondo (`r''m`, una variabile, uno script). È una rete contro l'errore, e
 * l'errore ha una forma riconoscibile — un `rm -rf` con un percorso sbagliato,
 * un `git reset --hard` su lavoro non committato, un `push --force` sul ramo di
 * qualcun altro. Sono le cose che NON SI ANNULLANO, ed è l'unico criterio con
 * cui questa lista cresce.
 *
 * In `yolo` passano: chi sceglie quel livello sta dicendo esattamente questo.
 */
const DESTRUCTIVE = [
  { re: /\bgit\s+reset\s+--hard\b/, what: "git reset --hard" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, what: "git clean -f" },
  { re: /\bgit\s+push\b.*(--force\b|-f\b)/, what: "git push forzato" },
  { re: /\bgit\s+branch\s+-D\b/, what: "cancellazione forzata di un ramo" },
  { re: /\b(mkfs|dd)\s/, what: "scrittura diretta su disco" },
  { re: /\bchmod\s+-R\s+777\b/, what: "chmod -R 777" },
  { re: />\s*\/dev\/(sd|disk)/, what: "scrittura su un device" },
  // Il caso che ha fatto storia altrove: cancellare la home o la radice.
];

const RM_FORCED = /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)/;
const RM_ROOT = /\brm\s+.*(\s|^)(\/|~|\$HOME)(\s|$)/;
const TEMP_ROOT = /^(\/tmp|\/private\/tmp|\/var\/folders|\/private\/var\/folders)\/[^\s]+$/;

/**
 * True when `target` is something this turn is allowed to remove: a path
 * under the generic `/tmp`-style roots, under THIS turn's own temp folder, or
 * a path this turn itself created (tracked in `scope.createdPaths`).
 *
 * A relative target (no leading `/`) is resolved against `scope.cwd` — the
 * bash call's own working directory — before the same checks run on it. A
 * turn working from its temp folder cleans up with plain relative names
 * (`rm -rf scratch`, not `rm -rf /tmp/topics-turn-xyz/scratch`), and that used
 * to be rejected outright for lack of a cwd to resolve against. Without
 * `scope.cwd` a relative target still never qualifies: guessing one would be
 * the widening this guard exists to avoid.
 */
function targetAllowed(target: string, scope?: TurnScope): boolean {
  if (target.includes("..")) return false;
  const abs = isAbsolute(target) ? resolve(target) : scope?.cwd ? resolve(scope.cwd, target) : null;
  if (abs === null) return false;
  if (TEMP_ROOT.test(abs)) return true;
  if (scope?.tempDir && insideDir(abs, scope.tempDir)) return true;
  if (scope?.createdPaths?.has(abs)) return true;
  return false;
}

/**
 * Returns the reason when an `rm` segment is dangerous, otherwise null.
 * An rm whose targets all sit under a temp root, the turn's own temp folder,
 * or files the turn created, only removes what the turn owns, so it passes.
 */
function rmTargets(args: string[]): string[] {
  const targets: string[] = [];
  let afterDashes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a) continue;
    // A redirection is not a target: `rm -f /tmp/x 2>/dev/null`, `rm -f /tmp/x > /dev/null`.
    if (/^\d*>>?$/.test(a)) { i++; continue; }
    if (/^\d*>>?\S/.test(a)) continue;
    if (!afterDashes && a === "--") { afterDashes = true; continue; }
    if (!afterDashes && a.startsWith("-")) continue;
    // Single quotes keep `$TMPDIR` literal, so it is a relative path, not the temp root.
    targets.push(a.replace(/^(["']?)\$\{?(?:TMPDIR|TMP)\}?(?=\/|["']?$)/, (m, q: string) => (q === "'" ? m : `${q}/tmp`)));
  }
  return targets;
}

function rmReason(segment: string, scope?: TurnScope): string | null {
  const forced = RM_FORCED.test(segment);
  const root = RM_ROOT.test(segment);
  if (!forced && !root) return null;
  const args = segment.slice(segment.search(/\brm\b/)).split(/\s+/).slice(1);
  const targets = rmTargets(args);
  const unquoted = targets.map((t) => t.replace(/^["']|["']$/g, ""));
  const allOwned = unquoted.length > 0 && unquoted.every((t) => targetAllowed(t, scope));
  if (allOwned) return null;
  return root ? "rm sulla radice o sulla home" : "rm ricorsivo o forzato";
}

const MKDIR_CALL = /\bmkdir\b([^;&|\n]*)/g;
const WORKTREE_ADD_CALL = /\bgit\s+worktree\s+add\s+([^;&|\n]*)/g;

/**
 * Best-effort paths a successful `bash` call just created, absolute and
 * resolved against `cwd`: `mkdir` (any flags, any number of targets) and
 * `git worktree add` (the path argument, skipping its own flags).
 *
 * This is NOT a shell parser — quoting, substitution and `&&` chains inside a
 * single segment can still fool it — so it only WIDENS what `targetAllowed`
 * accepts, never narrows: missing a path here just means that path stays
 * closed to a later `rm`, the safe direction to be wrong in.
 */
export function pathsCreatedBy(command: string, cwd: string): string[] {
  const found: string[] = [];
  for (const m of command.matchAll(MKDIR_CALL)) {
    for (const arg of m[1]!.trim().split(/\s+/)) {
      if (!arg || arg.startsWith("-")) continue;
      found.push(isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg));
    }
  }
  for (const m of command.matchAll(WORKTREE_ADD_CALL)) {
    const args = m[1]!.trim().split(/\s+/);
    const path = args.find((a) => !a.startsWith("-"));
    if (path) found.push(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
  }
  return found;
}

/**
 * Questo tool, con questi argomenti, si può eseguire?
 *
 * Restituisce un motivo LEGGIBILE quando dice no: quel testo torna all'agente
 * come risultato del tool, ed è ciò che gli permette di cambiare strada invece
 * di ritentare uguale. Un rifiuto muto fa girare l'agente in tondo.
 */
export function decide(
  tool: string,
  input: Record<string, unknown>,
  level: AutonomyLevel = DEFAULT_AUTONOMY,
  scope?: TurnScope,
): ToolDecision {
  if (READ_ONLY.has(tool)) return { allow: true };

  if (level === "ask") {
    return {
      allow: false,
      reason:
        `Questa conversazione è in modalità «chiedi prima»: puoi leggere e cercare, ` +
        `ma non modificare né eseguire. Descrivi cosa faresti e lascia decidere all'utente.`,
    };
  }

  if (level === "yolo") return { allow: true };

  // auto-apply: si lavora, ma le cose irreversibili no.
  if (tool === "bash") {
    const cmd = String(input.command ?? "");
    for (const seg of cmd.split(/[;&|\n]+/)) {
      const what = rmReason(seg, scope);
      if (what) {
        return {
          allow: false,
          reason:
            `Comando bloccato (${what}): è un'operazione che non si annulla, e questa ` +
            `conversazione non è in modalità «yolo». Se serve davvero, chiedilo all'utente. ` +
            `rm su /tmp e sulle cartelle temporanee è invece permesso.`,
        };
      }
    }
    for (const d of DESTRUCTIVE) {
      if (d.re.test(cmd)) {
        return {
          allow: false,
          reason:
            `Comando bloccato (${d.what}): è un'operazione che non si annulla, e questa ` +
            `conversazione non è in modalità «yolo». Se serve davvero, chiedilo all'utente.`,
        };
      }
    }
  }

  return { allow: true };
}

/** Il livello di una topic, normalizzato. Un valore sconosciuto cade sul default. */
export function levelFor(raw: string | null | undefined): AutonomyLevel {
  return raw === "ask" || raw === "auto-apply" || raw === "yolo" ? raw : DEFAULT_AUTONOMY;
}

/**
 * The turn now owns what a SUCCESSFUL tool call just made, so a later `rm` on
 * that path is cleanup of its own work (RT-07). Called by the loop after each
 * non-error result; a failed write or `mkdir` created nothing to own.
 */
export function recordTurnCreatedPaths(
  created: Set<string>,
  tool: string,
  input: Record<string, unknown>,
  workspace: string,
): void {
  if (tool === "write_file" || tool === "edit_file") {
    const raw = String(input.path ?? "");
    if (raw) created.add(isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw));
  } else if (tool === "bash") {
    const cwd = input.cwd ? String(input.cwd) : workspace;
    const abs = isAbsolute(cwd) ? resolve(cwd) : resolve(workspace, cwd);
    for (const p of pathsCreatedBy(String(input.command ?? ""), abs)) created.add(p);
  }
}
