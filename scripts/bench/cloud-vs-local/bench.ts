// Quattro card con lo stesso compito, in cloud (adattatore claude-cloud) o in locale
// (la CLI come la lancia il provider claude-code: stream-json in un worktree a sé).
// Uso: bun bench.ts cloud|local <cartella-risultati>
// Le card cloud usano l'account di CLOUD_ACCOUNT (vdm auto-N) o quello loggato.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudApi } from "../../../server/providers/claude-cloud/api";
import { credsFor } from "../../../server/providers/claude-cloud/creds";
import { CloudSessionRunner } from "../../../server/providers/claude-cloud/session";
import type { StreamHandler } from "../../../server/providers/types";

const N = 4;
const MODEL = "claude-sonnet-5-5";
const EFFORT = "low";
const REPO = "armonia/topics-app";
const REPO_DIR = join(import.meta.dir, "../../..");

// BENCH_TASK=heavy aggiunge il typecheck di tutto il repo, il passo che in una card vera pesa.
const HEAVY = process.env.BENCH_TASK === "heavy";
export const TASK = [
  "Compito di misura, senza modifiche al repo:",
  "1. esegui `bun install --frozen-lockfile` nella radice del repo;",
  "2. esegui `bun test shared/` e leggi il risultato;",
  ...(HEAVY ? ["2b. esegui `bunx tsc --noEmit -p tsconfig.server.json` e conta gli errori (anche zero);"] : []),
  "3. apri `shared/board.ts` e dimmi in una riga cosa contiene.",
  `Rispondi in ${HEAVY ? 4 : 3} righe: test passati, falliti,${HEAVY ? " errori di tsc," : ""} la riga su board.ts.`,
  "Non modificare file, non fare commit, non fare push, non aprire PR.",
].join("\n");

const [mode, outDir] = process.argv.slice(2);
if ((mode !== "cloud" && mode !== "local") || !outDir) {
  console.error("uso: bun bench.ts cloud|local <cartella>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const quiet = (log: string[]): StreamHandler =>
  ({
    onTextDelta: (d: string) => log.push(d),
    onToolStart: (_id: string, name: string) => log.push(`[${name}]`),
    onToolResult: () => {},
    onDone: () => log.push("[done]"),
    onError: (e: string) => log.push(`[error] ${e}`),
  }) as unknown as StreamHandler;

async function cloudCard(i: number) {
  const runner = new CloudSessionRunner(new CloudApi(credsFor(process.env.CLOUD_ACCOUNT)));
  const log: string[] = [];
  const t0 = Date.now();
  const r = await runner.sendTurn(`bench-${i}`, TASK, quiet(log), {
    source: { repo: REPO, revision: "main" },
    deliveryBranch: `claude/bench-cloud-${i}`,
    model: MODEL,
    effort: EFFORT,
    title: `Misura carico card cloud ${i}`,
    // Solo i comandi del compito; il resto no.
    onPermission: async (a) => {
      const cmd = String((a.input as { command?: string } | undefined)?.command ?? "");
      return /^(bun (install|test)|cat|ls|head|sed -n)\b/.test(cmd) ? { allow: true } : { allow: false, message: "fuori dal compito" };
    },
    stallMs: 10 * 60_000,
  });
  return { i, mode: "cloud", ms: Date.now() - t0, outcome: r.outcome, session: r.sessionId, tail: log.join("").slice(-400) };
}

async function localCard(i: number) {
  // Worktree pulito come quello di una card: stesso commit, niente node_modules.
  const wt = join(outDir, `wt-${i}`);
  Bun.spawnSync(["git", "-C", REPO_DIR, "worktree", "add", "--detach", wt, "origin/main"]);
  const t0 = Date.now();
  const p = Bun.spawn(
    ["claude", "-p", TASK, "--output-format", "stream-json", "--verbose", "--model", MODEL, "--effort", EFFORT,
      "--permission-mode", "bypassPermissions"],
    { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, OFFLOAD: "local" } },
  );
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  writeFileSync(join(outDir, `local-${i}.ndjson`), out);
  // Il result non è per forza l'ultima riga: dopo può arrivare un task_summary.
  const result = out.split("\n").filter((l) => l.includes('"type":"result"')).at(-1) ?? "";
  let outcome = "error";
  try { if (code === 0 && JSON.parse(result).subtype === "success") outcome = "done"; } catch {}
  return { i, mode: "local", ms: Date.now() - t0, outcome, exit: code, tail: result.slice(-400) };
}

const results = await Promise.all(Array.from({ length: N }, (_, i) => (mode === "cloud" ? cloudCard(i) : localCard(i))));
writeFileSync(join(outDir, `${mode}-results.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ tail, ...r }) => r)));
