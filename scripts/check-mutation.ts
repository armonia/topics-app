#!/usr/bin/env bun
/**
 * L'INDICE «SOLIDO»: quanta parte degli errori possibili i test prendono davvero.
 *
 * La copertura delle righe dice che una riga è stata eseguita, non che un errore
 * in quella riga farebbe diventare rosso qualcosa. Il mutation score sì: Stryker
 * rompe il codice apposta (stryker.config.mjs) e conta quante rotture la suite
 * prende. Score = (killed + timeout) / (killed + timeout + survived + no coverage).
 * I mutanti che non compilano o che si rompono da soli non contano né a favore né
 * contro: non provano niente.
 *
 * PERCHÉ UN RATCHET. Come `check:bloat` e `check:any-budget`: si parte da dove
 * siamo, e il numero di ogni modulo può solo salire. Un modulo che scende è un
 * test indebolito o un ramo nuovo senza test, ed è rosso. Uno che sale stampa
 * la riga per fissarlo (`--update-baseline`), che non abbassa mai niente:
 * abbassare una soglia è una modifica a mano della baseline, che si vede in review.
 *
 * Anche al 100% non è «certo»: prova che i test prendono ogni mutazione che
 * Stryker sa fare, non che il comportamento voluto sia quello giusto. Per quello
 * ci sono le spec (`check:spec-coverage`).
 *
 * Uso:
 *   bun run check:mutation                    confronta reports/mutation/mutation.json con la baseline
 *   bun run check:mutation --update-baseline  fissa gli score saliti (mai quelli scesi)
 *   bun run check:mutation --report <file>    legge un altro report
 * Il report lo scrive `bun run mutation` (pesante: in CI gira nel job `mutation`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CRITICAL } from "./mutation-critical.ts";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_FILE = resolve(ROOT, "scripts/mutation-baseline.json");
const DEFAULT_REPORT = resolve(ROOT, "reports/mutation/mutation.json");

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

export type FileScore = { detected: number; undetected: number; score: number };
type Report = { files: Record<string, { mutants: { status: string }[] }> };

/** Lo score di ogni file del report, in percento con un decimale. */
export function scoresOf(report: Report): Record<string, FileScore> {
  const out: Record<string, FileScore> = {};
  for (const [file, { mutants }] of Object.entries(report.files ?? {})) {
    const detected = mutants.filter((m) => DETECTED.has(m.status)).length;
    const undetected = mutants.filter((m) => UNDETECTED.has(m.status)).length;
    const valid = detected + undetected;
    out[normalize(file)] = { detected, undetected, score: valid ? round1((detected / valid) * 100) : 100 };
  }
  return out;
}

/** L'indice di tutto il recinto: mutanti presi su mutanti validi, non la media dei file. */
export function overall(scores: Record<string, FileScore>): number {
  const d = Object.values(scores).reduce((s, f) => s + f.detected, 0);
  const u = Object.values(scores).reduce((s, f) => s + f.undetected, 0);
  return d + u ? round1((d / (d + u)) * 100) : 100;
}

export type Verdict = { file: string; ok: boolean; line: string };

/**
 * Ogni modulo critico contro la sua baseline. Rosso se manca nel report (non
 * misurato non è passato), se manca nella baseline (un modulo entra con il suo
 * numero), o se lo score è sceso.
 */
export function judge(
  critical: string[],
  scores: Record<string, FileScore>,
  baseline: Record<string, number>,
): Verdict[] {
  return critical.map((file) => {
    const now = scores[file];
    const base = baseline[file];
    if (!now) return { file, ok: false, line: `${file}: not in the mutation report, so not measured` };
    if (base === undefined)
      return { file, ok: false, line: `${file}: ${now.score}% but no baseline. Record it with --update-baseline` };
    if (now.score < base)
      return { file, ok: false, line: `${file}: ${now.score}% < baseline ${base}% (${now.undetected} mutants survive)` };
    const up = now.score > base ? ` (up from ${base}%: run --update-baseline to lock it in)` : "";
    return { file, ok: true, line: `${file}: ${now.score}%${up}` };
  });
}

/** La baseline nuova: per ogni modulo il massimo fra quella vecchia e lo score di oggi. */
export function raised(
  critical: string[],
  scores: Record<string, FileScore>,
  baseline: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const file of critical) {
    const now = scores[file]?.score;
    const base = baseline[file];
    if (now === undefined && base === undefined) continue;
    next[file] = Math.max(now ?? -Infinity, base ?? -Infinity);
  }
  return next;
}

function normalize(p: string): string {
  const rel = p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
  return rel.replace(/\\/g, "/");
}

function round1(n: number): number {
  return Math.floor(n * 10) / 10;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reportPath = args.includes("--report") ? resolve(args[args.indexOf("--report") + 1]) : DEFAULT_REPORT;
  if (!existsSync(reportPath)) {
    console.error(`check:mutation: no report at ${reportPath}. Run \`bun run mutation\` first.`);
    process.exit(1);
  }
  const scores = scoresOf(JSON.parse(readFileSync(reportPath, "utf8")));
  const baseline: Record<string, number> = existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")).scores
    : {};
  const critical = CRITICAL.map((m) => m.source);

  if (args.includes("--update-baseline")) {
    const next = raised(critical, scores, baseline);
    writeFileSync(BASELINE_FILE, JSON.stringify({ $schema: "mutation-baseline-v1", scores: next }, null, 2) + "\n");
    console.log(`check:mutation: baseline written, ${Object.keys(next).length} modules, never lowered`);
    process.exit(0);
  }

  const verdicts = judge(critical, scores, baseline);
  for (const v of verdicts) console.log(`  ${v.ok ? "verde" : "ROSSO"}  ${v.line}`);
  const inScope = Object.fromEntries(critical.filter((f) => scores[f]).map((f) => [f, scores[f]]));
  console.log(`check:mutation: indice solido ${overall(inScope)}% su ${critical.length} moduli critici`);
  if (verdicts.some((v) => !v.ok)) process.exit(1);
}
