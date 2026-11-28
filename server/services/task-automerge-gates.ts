// The fast static gates the land runs on a realign merge before pushing it.
// Kept apart from `task-automerge.ts`, which is already over its size ceiling.

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { installWorktreeDeps } from "../lib/worktree-install-deps";

interface ScriptResult { code: number; stdout: string; stderr: string }

/**
 * The fast static gates of the CI `gates` job, run on the realign merge before the
 * land pushes it (seconds, not the 15-40 minutes of the whole CI). Only the ones
 * the repo being landed declares: another project has none of these scripts.
 */
const STATIC_GATE_SCRIPTS = ["lint:design-system", "check:deadcode-prod", "gates:fast"];

/**
 * `red`: a gate measured the tree and rejected it (back to the agent).
 * `unmeasured`: a gate could not measure (no dependencies, unknown command, timeout or
 * slot wait): never a green, never the tree's fault, so the card goes to review.
 */
export interface StaticGateVerdict { kind: "red" | "unmeasured"; detail: string }

/** `bun run` was killed by the land's deadline (or `slot.ts` gave up waiting): exit 124. */
const TIMEOUT_EXIT_CODE = 124;
const UNKNOWN_COMMAND = /unknown command|comando sconosciuto/i;

/**
 * First gate that is not green, or `null` when all are. A temporary realign worktree is
 * born without `node_modules`: the dependencies are installed there first, and when they
 * are not there the answer is `unmeasured`, never green.
 */
export async function runStaticGates(
  cwd: string,
  runScript: (cwd: string, args: string[]) => Promise<ScriptResult>,
  install: (cwd: string) => Promise<unknown> = installWorktreeDeps,
): Promise<StaticGateVerdict | null> {
  let declared: Record<string, string> = {};
  try { declared = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {}; } catch { return null; }
  const scripts = STATIC_GATE_SCRIPTS.filter((s) => declared[s]);
  if (scripts.length === 0) return null;
  if (!existsSync(join(cwd, "node_modules"))) {
    await install(cwd).catch(() => undefined);
    if (!existsSync(join(cwd, "node_modules"))) {
      return { kind: "unmeasured", detail: "le dipendenze non si sono potute installare nel worktree della fusione: nessun cancello ha misurato niente" };
    }
  }
  for (const script of scripts) {
    const r = await runScript(cwd, [script]);
    if (r.code === 0) continue;
    const text = `${r.stderr}\n${r.stdout}`;
    const out = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const line = `bun run ${script} (exit ${r.code}): ${(out.at(-1) ?? "no output").slice(0, 300)}`;
    if (r.code === TIMEOUT_EXIT_CODE) return { kind: "unmeasured", detail: `${line} (scaduto il tempo o l'attesa dello slot: il cancello non ha misurato l'albero)` };
    if (UNKNOWN_COMMAND.test(text)) return { kind: "unmeasured", detail: `${line} (lo strumento installato non ha questo comando: non è un rosso dell'albero)` };
    return { kind: "red", detail: line };
  }
  return null;
}

/** What the agent does when the realign merge itself turned a fast static gate red. */
export const REALIGN_GATES_INSTRUCTION =
  "Il land ha riportato main dentro il tuo ramo e la fusione fa uscire rosso un cancello statico (comando e riga nel commento sopra): " +
  "non ho spinto niente e il ramo è tornato com'era. Nel tuo worktree fai `git fetch origin && git merge origin/main`, " +
  "correggi ciò che il cancello boccia, committa, poi rimetti in review con update_task(status=\"review\"). " +
  "Resta vietato toccare main: niente push, niente merge verso main.";
