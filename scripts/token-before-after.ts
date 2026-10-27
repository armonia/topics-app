#!/usr/bin/env bun
/**
 * token-before-after - the tokens of one chat turn, before and after a restart.
 *
 * The fixes from the token study (5.5 prices, on-demand MCP schemas, resent
 * context, history capped at 110k, one-hour cache, pruned images) are judged on
 * a single number: how much an assistant turn weighs before the restart onto
 * the new main and how much after. This script reads it from `messages`, READ
 * ONLY, so it can run against the production DB while the server is up.
 *
 *   bun scripts/token-before-after.ts --cut 2026-10-26T15:17:42Z
 *   bun scripts/token-before-after.ts --cut 2026-10-26T15:17:42Z --hours 24 --json
 *
 * `--cut` is the instant of the restart (ISO; without a zone it is read as UTC,
 * like the `timestamp` columns). "Before" is the window of `--hours` hours (48
 * by default) that ends at the cut, "after" the one that starts at the cut.
 *
 * It counts only the rows the server actually measured: role `assistant`, not
 * partial, `usage_prompt_tokens` not NULL. NULL means "we do not know"
 * (migration 070) and turning it into a zero would lower the average.
 *
 * The parts follow the conventions of `messages`: `usage_prompt_tokens`
 * ALREADY INCLUDES the cache re-read (`shared/token-cost.ts`), and the two
 * cache writes, 5-minute and one-hour, are disjoint shares (migration 070). The
 * cost in equivalent tokens is `costTokens`, the same number as the UI.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { costTokens, partsFromMessage } from "../shared/token-cost";

interface Args { cut: string; hours: number; dbPath: string; json: boolean }

interface MessageRow {
  usage_prompt_tokens: number;
  usage_completion_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  cost_cents: number | null;
}

interface Side {
  from: string;
  to: string;
  turns: number;
  /** Averages per turn. */
  prompt: number;
  fresh: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  costTokens: number;
  costCents: number;
  /** Medians per turn: one huge agentic turn must not decide on its own. */
  medianPrompt: number;
  medianCostTokens: number;
  /** Share of the prompt served from cache, over the whole window. */
  cacheHitShare: number;
}

function parseArgs(argv: string[]): Args {
  let cut = "";
  let hours = 48;
  let dbPath = process.env.DATA_DIR ? join(process.env.DATA_DIR, "topics.db") : resolve("data/topics.db");
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { json = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Manca il valore di ${flag}`);
    if (flag === "--cut") cut = value;
    else if (flag === "--hours") hours = Number(value);
    else if (flag === "--db") dbPath = resolve(value);
    else throw new Error(`Opzione sconosciuta: ${flag}`);
    i++;
  }
  if (!cut) throw new Error("Serve --cut <ISO>, l'istante del riavvio sul main nuovo");
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(cut) ? cut : `${cut}Z`;
  const at = Date.parse(withZone);
  if (Number.isNaN(at)) throw new Error(`--cut non è una data: ${cut}`);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--hours non valido: ${hours}`);
  return { cut: new Date(at).toISOString(), hours, dbPath, json };
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarize(rows: MessageRow[], from: string, to: string): Side {
  const nz = (v: number | null) => Math.max(0, v ?? 0);
  const prompts = rows.map((r) => nz(r.usage_prompt_tokens));
  const reads = rows.map((r) => nz(r.cache_read_tokens));
  const costs = rows.map((r) =>
    costTokens(partsFromMessage({
      usagePromptTokens: r.usage_prompt_tokens,
      usageCompletionTokens: r.usage_completion_tokens,
      cacheReadTokens: r.cache_read_tokens,
    })),
  );
  const promptTotal = prompts.reduce((a, b) => a + b, 0);
  const readTotal = reads.reduce((a, b) => a + b, 0);
  return {
    from,
    to,
    turns: rows.length,
    prompt: mean(prompts),
    fresh: mean(rows.map((r) =>
      Math.max(0, nz(r.usage_prompt_tokens) - nz(r.cache_read_tokens) - nz(r.cache_creation_tokens) - nz(r.cache_creation_1h_tokens)),
    )),
    cacheRead: mean(reads),
    cacheWrite5m: mean(rows.map((r) => nz(r.cache_creation_tokens))),
    cacheWrite1h: mean(rows.map((r) => nz(r.cache_creation_1h_tokens))),
    output: mean(rows.map((r) => nz(r.usage_completion_tokens))),
    costTokens: mean(costs),
    costCents: mean(rows.map((r) => nz(r.cost_cents))),
    medianPrompt: median(prompts),
    medianCostTokens: median(costs),
    cacheHitShare: promptTotal > 0 ? Math.min(1, readTotal / promptTotal) : 0,
  };
}

function readSide(db: Database, from: string, to: string): Side {
  const rows = db.prepare(`
    SELECT usage_prompt_tokens, usage_completion_tokens, cache_read_tokens,
           cache_creation_tokens, cache_creation_1h_tokens, cost_cents
      FROM messages
     WHERE role = 'assistant'
       AND COALESCE(partial, 0) = 0
       AND usage_prompt_tokens IS NOT NULL
       AND timestamp >= ? AND timestamp < ?
  `).all(from, to) as MessageRow[];
  return summarize(rows, from, to);
}

const fmt = (v: number) => Math.round(v).toLocaleString("it-IT");

function delta(before: number, after: number): string {
  if (before === 0) return "—";
  const pct = ((after - before) / before) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function printTable(before: Side, after: Side): void {
  console.log(`prima: ${before.from} → ${before.to}  (${before.turns} turni)`);
  console.log(`dopo:  ${after.from} → ${after.to}  (${after.turns} turni)\n`);
  const lines: Array<[string, number, number, (v: number) => string]> = [
    ["prompt medio", before.prompt, after.prompt, fmt],
    ["  fresco", before.fresh, after.fresh, fmt],
    ["  cache letta", before.cacheRead, after.cacheRead, fmt],
    ["  cache scritta 5m", before.cacheWrite5m, after.cacheWrite5m, fmt],
    ["  cache scritta 1h", before.cacheWrite1h, after.cacheWrite1h, fmt],
    ["output medio", before.output, after.output, fmt],
    ["costo medio (token eq.)", before.costTokens, after.costTokens, fmt],
    ["costo medio (cent)", before.costCents, after.costCents, (v) => v.toFixed(2)],
    ["prompt mediano", before.medianPrompt, after.medianPrompt, fmt],
    ["costo mediano (token eq.)", before.medianCostTokens, after.medianCostTokens, fmt],
    ["quota cache del prompt", before.cacheHitShare, after.cacheHitShare, (v) => `${(v * 100).toFixed(1)}%`],
  ];
  const w = Math.max(...lines.map(([label]) => label.length));
  console.log(`${"".padEnd(w)}  ${"prima".padStart(12)}  ${"dopo".padStart(12)}  ${"Δ".padStart(8)}`);
  for (const [label, b, a, f] of lines) {
    console.log(`${label.padEnd(w)}  ${f(b).padStart(12)}  ${f(a).padStart(12)}  ${delta(b, a).padStart(8)}`);
  }
  if (before.turns === 0 || after.turns === 0) {
    console.log("\nUna delle due finestre è vuota: il confronto non dice ancora niente.");
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dbPath)) throw new Error(`Nessun DB in ${args.dbPath}. Passa --db o DATA_DIR=…`);
  const cutMs = Date.parse(args.cut);
  const span = args.hours * 3_600_000;
  const from = new Date(cutMs - span).toISOString();
  const to = new Date(cutMs + span).toISOString();
  const db = new Database(args.dbPath, { readonly: true });
  try {
    const before = readSide(db, from, args.cut);
    const after = readSide(db, args.cut, to);
    if (args.json) console.log(JSON.stringify({ cut: args.cut, hours: args.hours, before, after }));
    else printTable(before, after);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
