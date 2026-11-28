// The fast static gates the land runs on a realign merge before pushing it.
// Kept apart from `task-automerge.ts`, which is already over its size ceiling.

import { join } from "path";
import { existsSync, readFileSync } from "fs";

interface ScriptResult { code: number; stdout: string; stderr: string }

/**
 * The fast static gates of the CI `gates` job, run on the realign merge before the
 * land pushes it (seconds, not the 15-40 minutes of the whole CI). Only the ones
 * the repo being landed declares: another project has none of these scripts.
 */
const STATIC_GATE_SCRIPTS = ["lint:design-system", "check:deadcode-prod", "gates:fast"];

/** First red gate as `"<command> (exit N): <last line>"`, or `null` when all are green. */
export async function runStaticGates(
  cwd: string,
  runScript: (cwd: string, args: string[]) => Promise<ScriptResult>,
): Promise<string | null> {
  let declared: Record<string, string> = {};
  try { declared = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {}; } catch { return null; }
  // Without installed dependencies every gate fails for a reason that is not the tree's.
  if (!existsSync(join(cwd, "node_modules"))) return null;
  for (const script of STATIC_GATE_SCRIPTS) {
    if (!declared[script]) continue;
    const r = await runScript(cwd, [script]);
    if (r.code === 0) continue;
    const out = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
    return `bun run ${script} (exit ${r.code}): ${(out.at(-1) ?? "no output").slice(0, 300)}`;
  }
  return null;
}

/** What the agent does when the realign merge itself turned a fast static gate red. */
export const REALIGN_GATES_INSTRUCTION =
  "Il land ha riportato main dentro il tuo ramo e la fusione fa uscire rosso un cancello statico (comando e riga nel commento sopra): " +
  "non ho spinto niente e il ramo è tornato com'era. Nel tuo worktree fai `git fetch origin && git merge origin/main`, " +
  "correggi ciò che il cancello boccia, committa, poi rimetti in review con update_task(status=\"review\"). " +
  "Resta vietato toccare main: niente push, niente merge verso main.";
