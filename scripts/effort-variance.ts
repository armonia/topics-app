#!/usr/bin/env bun
/**
 * Quanto balla il giudice del dispatch — misurato, non stimato.
 *
 * Da quando l'effort è `auto`, lo sforzo di un task dispatchato lo sceglie una
 * chiamata haiku one-shot (`pickTaskPlan`). Chiamata tre volte di fila sullo
 * stesso testo aveva risposto `opus medium`, `opus high`, `opus medium`: il
 * modello reggeva, lo sforzo no. Siccome l'effort è la leva di costo più pesante
 * che abbiamo (stesso micro-task: 61,1k token a `medium`, 108,8k a `xhigh`),
 * quel ballo è denaro — e prima di mettere un rimedio serve sapere QUANTO balla.
 *
 * Questa sonda usa il PROMPT VERO e i PARSER VERI del picker (importati, non
 * ricopiati): se domani il prompt cambia, la misura cambia con lui invece di
 * misurare una fotocopia. L'unica cosa che non usa è `pickTaskPlan` intero,
 * perché serve vedere la risposta grezza di ogni singolo voto.
 *
 * Il numero che conta NON è «quante risposte diverse ho visto»: è la probabilità
 * che DUE dispatch indipendenti dello stesso task ricevano un verdetto diverso,
 * cioè `1 - Σ pᵢ²` sulla distribuzione osservata (indice di Gini/Simpson). È
 * esattamente la domanda «lo stesso task, dispatchato due volte, costa uguale?».
 *
 *   bun scripts/effort-variance.ts --n 20 --out docs/effort-variance/run.json
 *   bun scripts/effort-variance.ts --n 20 --vote 3     # con il rimedio
 *
 * `--vote K` misura il rimedio: ogni prova è una MEDIANA di K voti (che con K=3
 * coincide col voto di maggioranza quando una maggioranza c'è), quindi una prova
 * costa K chiamate. `--n 20 --vote 3` = 60 chiamate haiku.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CLASSIFIER_PROMPT, readVote, tallyVotes, type JudgeVote,
} from "../server/services/task-model-picker";
import { buildClaudeOneshotArgs } from "../server/providers/claude/args";

const JUDGE_MODEL = "claude-haiku-4-5";

// Il testo di prova è quello della campagna board-vs-chat (`microTaskText`), non
// uno inventato qui: è lo stesso task su cui sono stati misurati i 61,1k/108,8k,
// e l'`arms.json` ne porta lo sha256 — così la misura è ripetibile e il testo
// non può cambiare sotto i piedi senza che si veda.
function microTask(): { text: string; description: string } {
  const arms = JSON.parse(readFileSync(new URL("./board-vs-chat.arms.json", import.meta.url), "utf-8"));
  return { text: "token-live: opzione --json", description: String(arms.microTaskText ?? "") };
}

/** Una chiamata al giudice, com'è in produzione: haiku, --print, zero MCP. */
function judge(prompt: string): Promise<string> {
  const args = buildClaudeOneshotArgs({ permissionMode: "bypassPermissions", model: JUDGE_MODEL, emptyMcpConfigPath: null });
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      try { resolve(String(JSON.parse(out).result ?? "")); } catch { resolve(out); }
    });
    proc.stdin.end(prompt);
  });
}

/**
 * Il tasso di disaccordo: la probabilità che due estrazioni indipendenti dalla
 * distribuzione osservata diano verdetti diversi. Zero = sempre lo stesso.
 * Usa la stima non distorta (senza reimmissione): 1 - Σ nᵢ(nᵢ-1) / N(N-1).
 */
function disagreement(labels: string[]): number {
  const n = labels.length;
  if (n < 2) return 0;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let same = 0;
  for (const c of counts.values()) same += c * (c - 1);
  return 1 - same / (n * (n - 1));
}

function tally(labels: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of labels) out[l] = (out[l] ?? 0) + 1;
  return out;
}

type Scored = { distribution: Record<string, Record<string, number>>; disagreement: Record<string, number> };
function score(rows: { model: string | null; effort: string | null }[]): Scored {
  const model = rows.map((r) => r.model ?? "∅");
  const effort = rows.map((r) => r.effort ?? "∅");
  const plan = rows.map((r) => `${r.model ?? "∅"} ${r.effort ?? "∅"}`);
  return {
    distribution: { model: tally(model), effort: tally(effort), plan: tally(plan) },
    disagreement: { model: disagreement(model), effort: disagreement(effort), plan: disagreement(plan) },
  };
}

/**
 * Il referto, dai voti grezzi. È una FUNZIONE dei voti e non dello stato della
 * corsa, così `--rescore` ricalcola un referto vecchio con la matematica nuova
 * invece di ri-comprare 60 chiamate — e la matematica resta una sola.
 *
 * `perVote` è il pezzo che conta davvero nel confronto: è il giudice SENZA
 * rimedio misurato sugli STESSI voti che il rimedio ha usato. Confrontare due
 * corse separate non basta, e non è un cavillo: fra la corsa baseline e quella a
 * tre voti — stesso testo, un'ora di distanza — la quota di `sonnet` è passata
 * dal 15% al 28%. La distribuzione del giudice non sta ferma nemmeno nel tempo,
 * quindi l'unico paragone che regge è appaiato, dentro la stessa corsa.
 */
function buildReport(meta: Record<string, unknown>, trials: { votes: JudgeVote[] }[]): Record<string, unknown> {
  const verdicts = trials.map((t) => {
    const v = tallyVotes(t.votes);
    return { model: v.tier as string | null, effort: v.effort as string | null };
  });
  const perVote = trials.flatMap((t) => t.votes.map((v) => ({ model: v.tier as string | null, effort: v.effort as string | null })));
  return {
    ...meta,
    ...score(verdicts),
    perVote: score(perVote),
    trials: trials.map((t, i) => ({
      ...verdicts[i]!,
      votes: t.votes.map((v) => ({ model: v.tier, effort: v.effort, raw: v.raw.slice(0, 80) })),
    })),
  };
}

async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]!();
    }
  }));
  return results;
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

const N = Number(arg("n", "20"));
const VOTE = Number(arg("vote", "1"));
const OUT = arg("out", "");
const WIDTH = Number(arg("width", "6"));
const RESCORE = arg("rescore", "");

let report: Record<string, unknown>;

if (RESCORE) {
  // Ricalcola un referto già pagato: i voti grezzi sono nel file, quindi le
  // metriche sono una derivazione, non una misura nuova.
  const old = JSON.parse(readFileSync(RESCORE, "utf-8"));
  const trials = old.trials.map((t: { votes: { raw: string }[] }) => ({ votes: t.votes.map((v) => readVote(v.raw)) }));
  const { distribution, disagreement: _d, perVote: _p, trials: _t, ...meta } = old;
  report = buildReport({ ...meta, rescoredFrom: RESCORE }, trials);
  console.log(`[effort-variance] ricalcolato da ${RESCORE} (${trials.length} prove, nessuna chiamata nuova)`);
} else {
  const task = microTask();
  const prompt = CLASSIFIER_PROMPT(task.text, task.description);
  console.log(`[effort-variance] ${N} prove × ${VOTE} vot${VOTE === 1 ? "o" : "i"} = ${N * VOTE} chiamate a ${JUDGE_MODEL}`);
  const t0 = Date.now();

  // Tutti i voti in un pool solo: le prove non si aspettano fra loro, e ogni
  // blocco di VOTE voti consecutivi forma una prova.
  const raws = await pool(
    Array.from({ length: N * VOTE }, (_, i) => async () => {
      const r = await judge(prompt).catch((e) => `ERROR: ${e instanceof Error ? e.message : String(e)}`);
      if ((i + 1) % 10 === 0) console.log(`  … ${i + 1}/${N * VOTE}`);
      return r;
    }),
    WIDTH,
  );

  // Ogni prova è un blocco di VOTE voti consecutivi, letto e messo ai voti con
  // gli STESSI `readVote`/`tallyVotes` che usa il dispatch: con `--vote 1` la
  // tornata di uno equivale al giudice di prima, quindi la baseline e il rimedio
  // passano per lo stesso codice e la differenza è solo il numero di voti.
  const trials: { votes: JudgeVote[] }[] = [];
  for (let i = 0; i < N; i++) trials.push({ votes: raws.slice(i * VOTE, (i + 1) * VOTE).map(readVote) });

  report = buildReport({
    schema: "effort-variance@2",
    judge: JUDGE_MODEL,
    n: N,
    votesPerTrial: VOTE,
    calls: N * VOTE,
    wallClockMs: Date.now() - t0,
    task: { text: task.text, descriptionChars: task.description.length },
  }, trials);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const scored = report as unknown as { distribution: Scored["distribution"]; disagreement: Scored["disagreement"]; perVote: Scored; votesPerTrial: number; calls: number; wallClockMs: number };
if (scored.votesPerTrial > 1) {
  console.log("\nconfronto APPAIATO, stessa corsa e stessi voti:");
  console.log(`  senza rimedio (voto singolo) modello ${pct(scored.perVote.disagreement.model!)} · sforzo ${pct(scored.perVote.disagreement.effort!)} · piano ${pct(scored.perVote.disagreement.plan!)}`);
  console.log(`  mediana di ${scored.votesPerTrial}            modello ${pct(scored.disagreement.model!)} · sforzo ${pct(scored.disagreement.effort!)} · piano ${pct(scored.disagreement.plan!)}`);
}
console.log(`\nmodello  ${JSON.stringify(scored.distribution.model)}  → disaccordo ${pct(scored.disagreement.model!)}`);
console.log(`sforzo   ${JSON.stringify(scored.distribution.effort)}  → disaccordo ${pct(scored.disagreement.effort!)}`);
console.log(`piano    ${JSON.stringify(scored.distribution.plan)}  → disaccordo ${pct(scored.disagreement.plan!)}`);
console.log(`(${scored.calls} chiamate in ${(scored.wallClockMs / 1000).toFixed(0)}s)`);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`referto → ${OUT}`);
}
