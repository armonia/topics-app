/**
 * ⚠️  QUELLO CHE ESCE DA QUI NON SI COMMITTA COM'È.
 *
 * Questo script legge il DATABASE VIVO, e quindi scrive nella fixture tre cose
 * che in un repo PUBBLICO non devono entrare:
 *   • `sessionKey`, cioè l'id reale della sessione — che finisce anche nel NOME
 *     del file, se lo si passa da riga di comando;
 *   • il titolo della chat, se lo si rimette nella `note` (la versione
 *     precedente di questo script ce lo scriveva dentro);
 *   • il riferimento a «estratto dal database vivo», che lega la misura alla
 *     macchina di chi l'ha eseguito.
 * I token e i costi invece vanno bene: senza id e senza titolo sono una curva
 * di costo che non si attacca a nessuno, ed è ciò che rende il test una
 * verifica invece che un aneddoto (il perché è scritto per esteso nel docblock
 * di `server/usage/cost-probe.test.ts`).
 *
 * Quindi, dopo aver rigenerato: riscrivi `sessionKey` con un valore sintetico e
 * la `note` senza titolo né id, oppure il cancello in fondo a
 * `server/usage/cost-probe.test.ts` («la fixture resta anonima») diventa rosso
 * — che è esattamente il suo mestiere. Il nome del file di destinazione qui
 * sotto è già anonimo apposta: non rimetterci dentro l'id.
 *
 * ── COSA FA ─────────────────────────────────────────────────────────────────
 * Estrae la fixture della BARRA: il prefisso di 46 messaggi di una chat reale,
 * ridotto ai soli fatti che parlano di costo (ruolo, token, costo, e i token
 * per singola chiamata a tool). Nessun contenuto: la fixture non deve portare
 * in repo una conversazione.
 *
 * Si esegue a mano contro il database vivo, in sola lettura:
 *   bun scripts/extract-cost-probe-fixture.ts [dbPath] [sessionKey] [nMessaggi]
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";

const dbPath = process.argv[2] || `${process.env.HOME}/Projects/topics-app/data/topics.db`;
// Nessun default: l'id di una sessione reale non si scrive in un repo pubblico,
// e un default sbagliato produrrebbe in silenzio una fixture vuota.
const sessionKey = process.argv[3];
if (!sessionKey) {
  console.error("uso: bun scripts/extract-cost-probe-fixture.ts [dbPath] <sessionKey> [nMessaggi]");
  process.exit(2);
}
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
    "APPENA RIGENERATA: da anonimizzare prima di committare — vedi l'intestazione di " +
    "scripts/extract-cost-probe-fixture.ts. Prefisso dei primi 46 messaggi di una chat reale, " +
    "ridotto ai soli fatti che parlano di costo: nessun contenuto. `misuraAMano` è il conto preso " +
    "a mano su quella chat a quel momento, ed è INDIPENDENTE da `rows` — la sonda deve ricostruirlo.",
  // Sintetico di proposito: l'id vero della sessione resta fuori dal file, e chi
  // rigenera deve scegliere di rimetterlo, non ritrovarselo scritto.
  sessionKey: "topic:fixture-barra",
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

const dest = "tests/fixtures/cost-probe-46-messages.json";
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(
  `${dest}: ${rows.length} messaggi · ${rows.reduce((s, r) => s + r.callTokens.length, 0)} chiamate · ` +
    `${rows.reduce((s, r) => s + r.promptTokens, 0)} prompt · $${(rows.reduce((s, r) => s + r.costCents, 0) / 100).toFixed(2)}`,
);
