#!/usr/bin/env bun
/**
 * Due prompt del giudice, misurati NELLA STESSA CORSA.
 *
 * `scripts/effort-variance.ts` risponde a «quanto balla il giudice». Questa
 * sonda risponde a un'altra domanda: «se cambio il PROMPT, la quota di `sonnet`
 * scende davvero?». Sono due domande diverse e servono due strumenti, ma la
 * matematica è la stessa e il vincolo di metodo è lo stesso — anzi, qui è più
 * stringente.
 *
 * **Perché appaiato e non prima/dopo.** La distribuzione del giudice non sta
 * ferma nel tempo: stesso testo, stesso prompt, un'ora di distanza, la quota di
 * `sonnet` è passata dal 15% al 28% (`docs/effort-variance/`). Misurare il
 * prompt vecchio adesso e quello nuovo fra un'ora significa misurare anche
 * quell'onda, e una differenza di 13 punti può nascere dal nulla. Quindi: i due
 * prompt vanno in UN SOLO pool, le chiamate si alternano, e ogni deriva del
 * provider colpisce i due bracci allo stesso modo.
 *
 * **Perché più di un task.** Un prompt che manda tutto su `opus` abbassa la
 * quota di `sonnet` sul task bersaglio e insieme rende il router inutile. La
 * batteria di controllo (`CASES`) tiene dentro anche task che `sonnet` DEVE
 * vincere: il rimedio si difende solo se sposta il bersaglio senza spostare
 * quelli.
 *
 *   bun scripts/prompt-ab.ts --n 20 --only token-live-json
 *   bun scripts/prompt-ab.ts --n 10 --out docs/effort-variance/prompt-ab.json
 *   bun scripts/prompt-ab.ts --rescore <referto>    # ricalcola, zero chiamate
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readVote, type JudgeVote, type ModelTier } from "../server/services/task-model-picker";
import { buildClaudeOneshotArgs } from "../server/providers/claude/args";
import { PROMPT_ARMS, type PromptArm } from "./prompt-ab.arms";

const JUDGE_MODEL = "claude-haiku-4-5";

/**
 * La batteria. Il bersaglio è `token-live-json` — lo stesso identico testo su
 * cui è misurata la varianza (viene da `board-vs-chat.arms.json`, con lo sha256
 * accanto, quindi non può cambiare sotto i piedi senza che si veda).
 *
 * Gli altri sono i CONTROLLI, e `expect` dice cosa devono restare: i due piccoli
 * sono lì per accorgersi se il rimedio, invece di correggere il bersaglio, si è
 * limitato ad alzare tutto.
 */
interface Case { id: string; expect: ModelTier; text: string; description: string }

function targetCase(): Case {
  const arms = JSON.parse(readFileSync(new URL("./board-vs-chat.arms.json", import.meta.url), "utf-8"));
  return {
    id: "token-live-json",
    expect: "opus",
    text: "token-live: opzione --json",
    description: String(arms.microTaskText ?? ""),
  };
}

const CASES: Case[] = [
  targetCase(),
  {
    id: "typo-readme",
    expect: "sonnet",
    text: "Correggi il refuso nel README",
    description: "Nel README, sezione Download, c'è scritto «instaler» invece di «installer». Correggilo.",
  },
  {
    id: "bump-version",
    expect: "sonnet",
    text: "Porta la versione a 2.4.1",
    description: "Aggiorna il campo `version` in `package.json` e in `desktop-tauri/src-tauri/tauri.conf.json` da 2.4.0 a 2.4.1. Nient'altro.",
  },
  {
    id: "debug-scroll",
    expect: "opus",
    text: "La chat ogni tanto salta in fondo mentre leggo indietro",
    description:
      "Scorrendo indietro nella cronologia di una chat che sta ancora ricevendo token, ogni tanto la vista viene ributtata in fondo. Non succede sempre e non si sa cosa lo scateni. Trovare la causa e sistemarla senza rompere l'auto-scroll di chi sta in fondo.",
  },
];

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

/** Stessa matematica di `effort-variance.ts`: la probabilità che due estrazioni
 *  indipendenti diano verdetti diversi, senza reimmissione. */
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

/**
 * L'intervallo di Wilson al 95% su una proporzione. Serve perché la domanda del
 * task è «la quota di `sonnet` è scesa?» e con N=20 una quota si sposta di
 * parecchi punti per caso: senza una barra d'errore, «15% → 5%» e «15% → 14%»
 * si leggono uguali, e non lo sono. Wilson e non la normale nuda perché qui le
 * quote stanno vicino a 0 e la normale ci sbatte fuori dal segmento [0,1].
 */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959963985, p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

type Cell = {
  arm: string; case: string; expect: ModelTier;
  votes: JudgeVote[];
};

function cellReport(cell: Cell) {
  const models = cell.votes.map((v) => v.tier ?? "∅");
  const efforts = cell.votes.map((v) => v.effort ?? "∅");
  const off = cell.votes.filter((v) => v.tier !== cell.expect).length;
  const [lo, hi] = wilson(off, cell.votes.length);
  return {
    arm: cell.arm, case: cell.case, expect: cell.expect, n: cell.votes.length,
    model: tally(models), effort: tally(efforts),
    // «fuori bersaglio» = la quota di voti che NON danno il modello atteso. Sul
    // bersaglio è esattamente la quota di `sonnet` del task; sui controlli è la
    // quota di voti che il rimedio ha spinto via da `sonnet`.
    offTarget: off / cell.votes.length, offTargetCI: [lo, hi],
    disagreement: { model: disagreement(models), effort: disagreement(efforts) },
    raws: cell.votes.map((v) => v.raw.replace(/\s+/g, " ").slice(0, 60)),
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
const WIDTH = Number(arg("width", "8"));
const OUT = arg("out", "");
const ONLY = arg("only", "");
const RESCORE = arg("rescore", "");

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

let report: Record<string, unknown>;

if (RESCORE) {
  const old = JSON.parse(readFileSync(RESCORE, "utf-8"));
  const cells: Cell[] = old.cells.map((c: { arm: string; case: string; expect: ModelTier; raws: string[] }) => ({
    arm: c.arm, case: c.case, expect: c.expect, votes: c.raws.map(readVote),
  }));
  const { cells: _c, ...meta } = old;
  report = { ...meta, rescoredFrom: RESCORE, cells: cells.map(cellReport) };
  console.log(`[prompt-ab] ricalcolato da ${RESCORE} (nessuna chiamata nuova)`);
} else {
  const cases = ONLY ? CASES.filter((c) => c.id === ONLY) : CASES;
  if (cases.length === 0) throw new Error(`--only ${ONLY}: nessun caso con questo id (${CASES.map((c) => c.id).join(", ")})`);
  const arms: PromptArm[] = PROMPT_ARMS;

  // UN SOLO pool, e l'ordine dei job alterna i bracci: se il provider rallenta o
  // si sposta a metà corsa, si sposta sotto entrambi. Il braccio è l'indice più
  // veloce apposta — job consecutivi sono lo stesso caso su bracci diversi.
  const jobs: { cell: Cell; prompt: string }[] = [];
  const cells = new Map<string, Cell>();
  for (const c of cases) {
    for (let k = 0; k < N; k++) {
      for (const a of arms) {
        const key = `${a.id}\u0000${c.id}`;
        let cell = cells.get(key);
        if (!cell) { cell = { arm: a.id, case: c.id, expect: c.expect, votes: [] }; cells.set(key, cell); }
        jobs.push({ cell, prompt: a.build(c.text, c.description) });
      }
    }
  }

  console.log(`[prompt-ab] ${arms.length} bracci × ${cases.length} cas${cases.length === 1 ? "o" : "i"} × ${N} = ${jobs.length} chiamate a ${JUDGE_MODEL}`);
  const t0 = Date.now();
  let done = 0;
  await pool(
    jobs.map((j) => async () => {
      const raw = await judge(j.prompt).catch((e) => `ERROR: ${e instanceof Error ? e.message : String(e)}`);
      j.cell.votes.push(readVote(raw));
      if (++done % 20 === 0) console.log(`  … ${done}/${jobs.length}`);
    }),
    WIDTH,
  );

  report = {
    schema: "prompt-ab@1",
    judge: JUDGE_MODEL,
    n: N,
    arms: arms.map((a) => ({ id: a.id, label: a.label, promptSha256: a.sha256(CASES[0]!.text, CASES[0]!.description) })),
    calls: jobs.length,
    wallClockMs: Date.now() - t0,
    cells: [...cells.values()].map(cellReport),
  };
}

const scored = report as unknown as {
  cells: ReturnType<typeof cellReport>[]; calls: number; wallClockMs: number; n: number;
};
const armIds = [...new Set(scored.cells.map((c) => c.arm))];
const caseIds = [...new Set(scored.cells.map((c) => c.case))];
console.log("\nquota FUORI BERSAGLIO (= quota del modello sbagliato), IC 95% di Wilson:");
for (const id of caseIds) {
  const row = scored.cells.filter((c) => c.case === id);
  console.log(`\n  ${id}  (atteso ${row[0]?.expect})`);
  for (const a of armIds) {
    const c = row.find((x) => x.arm === a);
    if (!c) continue;
    console.log(`    ${a.padEnd(10)} ${pct(c.offTarget).padStart(6)}  [${pct(c.offTargetCI[0])}, ${pct(c.offTargetCI[1])}]   ${JSON.stringify(c.model)}  sforzo ${JSON.stringify(c.effort)}`);
  }
}
console.log(`\n(${scored.calls} chiamate in ${(scored.wallClockMs / 1000).toFixed(0)}s)`);

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`referto → ${OUT}`);
}
