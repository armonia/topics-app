/**
 * Chi può fare cosa, per il runtime nativo.
 *
 * IL BUCO CHE CHIUDE. Il runtime nativo esegue i tool DA SÉ: non c'è una CLI in
 * mezzo che applichi le sue regole, quindi le regole sono queste e nient'altro.
 * Al primo giro `bash` e `write_file` eseguivano e basta — su una macchina
 * vera, con agenti dispacciati che girano da soli, è la lacuna che fa danno.
 *
 * NON È UNA SANDBOX, e va detto subito perché la differenza conta: un comando
 * shell può sempre uscire da qualunque perimetro (`ssh`, `curl | sh`, un
 * interprete). Qui si decide COSA L'AGENTE PUÒ CHIEDERE, non cosa il sistema
 * operativo gli lascia fare. Serve a fermare l'errore e l'iniziativa infelice,
 * non un avversario.
 *
 * I LIVELLI SONO QUELLI CHE TOPICS HA GIÀ (`AutonomyLevel`, sul topic), perché
 * un secondo sistema di permessi accanto al primo è il modo sicuro di averne
 * zero funzionanti:
 *
 *   • `ask`        — propone e non tocca: lettura sì, scrittura ed esecuzione
 *                    no. È il «plan mode» delle CLI, tradotto qui.
 *   • `auto-apply` — lavora nel progetto: legge, scrive, esegue. Fuori dal
 *                    perimetro non va (ci pensa già `tools.ts`), e i comandi
 *                    DISTRUTTIVI restano fuori.
 *   • `yolo`       — tutto, ed è una scelta esplicita di chi la mette.
 *
 * IL DEFAULT È `auto-apply`, non `yolo`. Le CLI storicamente partivano in
 * `bypassPermissions` e Topics ne ha ereditato il default per non zittire le
 * chat esistenti; ma quel default descriveva un programma altrui, mentre qui
 * l'esecuzione è nostra e la scelta pure. Un agente che non ha mai visto una
 * riga di configurazione non deve poter lanciare `rm -rf`.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { AutonomyLevel } from "../../../shared/types";
import { argsAfterWord, callCwd, resolveTarget, segmentCreations, unquote, walkShell, type ShellSegment } from "./shell-walk";
import { isWithin, topmostNew } from "./turn-files";
import { isRemovableTempPath } from "./temp-roots";

export type ToolDecision =
  | { allow: true }
  | { allow: false; reason: string };

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
  { re: /\bmkfs\s/, what: "scrittura diretta su disco" },
  { re: /\bchmod\s+-R\s+777\b/, what: "chmod -R 777" },
  { re: />\s*\/dev\/(sd|disk)/, what: "scrittura su un device" },
  // Il caso che ha fatto storia altrove: cancellare la home o la radice.
];

const RM_FORCED = /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)/;
const RM_ROOT = /\brm\s+.*(\s|^)(\/|~|\$HOME)(\s|$)/;

/**
 * What a turn may touch besides the temp folders: the files it created itself.
 *
 * `workspace` anchors relative paths and bounds the second clause; without one
 * only the temp folders count. `createdByTurn` is the registry of `turn-files.ts`
 * (earlier calls of the same turn); what an earlier part of the SAME command
 * creates counts too, read from the command text. Both are optional on purpose:
 * a caller that passes neither gets the rule as it was before the scope
 * existed, minus the parsing bugs listed in `rmReason`.
 */
export interface PermissionScope {
  workspace?: string;
  createdByTurn?: (abs: string) => boolean;
}

/** A path with nothing left for the shell to rewrite. */
const PLAIN_PATH = /^[^$`(){}]*$/;

/** Strictly inside the workspace: never the workspace itself, never a parent. */
function insideWorkspace(abs: string, workspace: string): boolean {
  const rel = relative(resolve(workspace), abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** An `rm` target the turn may remove: under a temp folder, or a file it created in its workspace. */
function mayRemove(abs: string, scope: PermissionScope | undefined, madeHere: string[]): boolean {
  if (isRemovableTempPath(abs)) return true;
  const ws = scope?.workspace;
  if (!ws || !PLAIN_PATH.test(abs) || !insideWorkspace(abs, ws)) return false;
  return madeHere.some((m) => isWithin(abs, m)) || !!scope.createdByTurn?.(abs);
}

/**
 * Returns the reason when an `rm` in `cmd` is dangerous, otherwise null.
 *
 * An rm whose targets all sit under a temp root, or are files the turn created
 * in its workspace, only removes the turn's own things, so it passes.
 *
 * HOW THE TARGETS ARE READ matters as much as the list. Three parsing bugs used
 * to refuse temp-only commands (measured 10-12 Nov, 113 refusals): a trailing
 * space before `&&` became an empty target, `2>/dev/null` became a target, and
 * a relative path after `cd /tmp` was judged against the workspace. Anything the
 * reader cannot resolve to one absolute path stays refused.
 */
function rmReason(cmd: string, startCwd: string | null, scope: PermissionScope | undefined): string | null {
  let reason: string | null = null;
  // Folders and files an earlier part of this very command creates and that do
  // not exist yet: `cat > s.sh <<EOF ...; bash s.sh; rm -f s.sh`.
  const madeHere: string[] = [];
  walkShell(cmd, startCwd, (seg: ShellSegment) => {
    if (reason) return;
    const forced = RM_FORCED.test(seg.text);
    const root = RM_ROOT.test(seg.text);
    if (forced || root) {
      const targets = argsAfterWord(seg.text, /\brm\b/).filter((a) => !a.startsWith("-"));
      const allMine =
        targets.length > 0 &&
        targets.every((t) => {
          const abs = resolveTarget(t, seg);
          return abs !== null && mayRemove(abs, scope, madeHere);
        });
      if (!allMine) reason = root ? "rm sulla radice o sulla home" : "rm ricorsivo o forzato";
    }
    const ws = scope?.workspace;
    if (ws) {
      for (const abs of segmentCreations(seg)) {
        const top = topmostNew(abs, ws);
        if (top) madeHere.push(top);
      }
    }
  });
  return reason;
}

const DD_WORD = /\bdd\s/;
const DD_OUTPUT = /\bof=(\S+)/g;

/**
 * `dd` is destructive through ONE thing: where it writes (`of=`). The old rule
 * matched the word `dd` anywhere, and refused `yyyy-mm-dd` in a comment, a
 * `<dd>` tag in a JSX file, a python variable named `dd` and `for dd in ...`
 * (7 refusals, 10-12 Nov, none of them a disk write). A segment now counts only
 * when it names `dd` and an `of=` that is not an absolute path under a temp
 * folder: `of=/dev/disk2`, `of=$DEV`, `of=~/x` and `of=../x` all stay refused.
 */
function ddRefused(cmd: string): boolean {
  return cmd.split(/[;&|\n]+/).some((seg) => {
    if (!DD_WORD.test(seg)) return false;
    const outputs = [...seg.matchAll(DD_OUTPUT)].map((m) => unquote(m[1]!));
    return !outputs.every((o) => o.startsWith("/") && !o.includes("..") && isRemovableTempPath(resolve(o)));
  });
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
  scope?: PermissionScope,
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
    const what = rmReason(cmd, callCwd(input, scope?.workspace), scope);
    if (what) {
      return {
        allow: false,
        reason:
          `Comando bloccato (${what}): è un'operazione che non si annulla, e questa ` +
          `conversazione non è in modalità «yolo». Se serve davvero, chiedilo all'utente. ` +
          `rm su /tmp e sulle cartelle temporanee è invece permesso.`,
      };
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
    if (ddRefused(cmd)) {
      return {
        allow: false,
        reason:
          `Comando bloccato (scrittura diretta su disco): è un'operazione che non si annulla, e questa ` +
          `conversazione non è in modalità «yolo». Se serve davvero, chiedilo all'utente.`,
      };
    }
  }

  return { allow: true };
}

/** Il livello di una topic, normalizzato. Un valore sconosciuto cade sul default. */
export function levelFor(raw: string | null | undefined): AutonomyLevel {
  return raw === "ask" || raw === "auto-apply" || raw === "yolo" ? raw : DEFAULT_AUTONOMY;
}
