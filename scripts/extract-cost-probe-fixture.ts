/**
 * Estrae la fixture della BARRA: il prefisso di 46 messaggi della chat reale
 * `topic:4c8de758`, ridotto ai soli fatti che parlano di costo (ruolo, token,
 * costo, e i token per singola chiamata a tool). Nessun contenuto: la fixture
 * non deve portare in repo una conversazione.
 *
 * Si esegue a mano contro il database vivo, in sola lettura:
 *   bun scripts/extract-cost-probe-fixture.ts [dbPath] [sessionKey] [nMessaggi]
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";

const dbPath = process.argv[2] || `${process.env.HOME}/Projects/topics-app/data/topics.db`;
const sessionKey = process.argv[3] || "topic:4c8de758";
const limit = Number(process.argv[4] || 46);

const db = new Database(dbPath, { readonly: true });
const raw = db
  .prepare(
    `SELECT role, tool_calls, usage_prompt_tokens, usage_completion_tokens,
            cache_read_tokens, cache_creation_tokens, cost_cents, model
       FROM messages WHERE session_key = ? ORDER BY sort_order, timestamp LIMIT ?`,
  )
  .all(sessionKey, limit) as Array<Record<string, unknown>>;

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

const rows = raw.map((r) => {
  let callTokens: Array<number | null> = [];
  try {
    const arr = JSON.parse(String(r.tool_calls || "[]"));
    if (Array.isArray(arr)) {
      callTokens = arr.map((c: unknown) => {
        const t = c && typeof c === "object" ? (c as { tokens?: unknown }).tokens : undefined;
        return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
      });
    }
  } catch { /* JSON storto = zero chiamate, come nella sonda */ }
  return {
    role: r.role === "assistant" ? "assistant" : "user",
    promptTokens: n(r.usage_prompt_tokens),
    completionTokens: n(r.usage_completion_tokens),
    cacheReadTokens: n(r.cache_read_tokens),
    cacheCreationTokens: n(r.cache_creation_tokens),
    costCents: n(r.cost_cents),
    model: r.model != null ? String(r.model) : null,
    callTokens,
  };
});

const out = {
  note:
    "Prefisso dei primi 46 messaggi della chat reale topic:4c8de758 («Reference siti scene motion»), " +
    "estratto l'11/08/2026 dal database vivo. Solo i fatti che parlano di costo: nessun contenuto. " +
    "`misuraAMano` è il conto preso a mano su QUELLA chat a quel momento — la sonda deve ricostruirlo.",
  sessionKey,
  misuraAMano: {
    messaggi: 46,
    toolCalls: 104,
    contextTokens: 320_000,
    promptTokens: 20_500_000,
    costUsd: 14.67,
    ultimoTurnoPromptTokens: 3_070_000,
  },
  rows,
};

const dest = "tests/fixtures/cost-probe-topic-4c8de758.json";
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(
  `${dest}: ${rows.length} messaggi · ${rows.reduce((s, r) => s + r.callTokens.length, 0)} chiamate · ` +
    `${rows.reduce((s, r) => s + r.promptTokens, 0)} prompt · $${(rows.reduce((s, r) => s + r.costCents, 0) / 100).toFixed(2)}`,
);
