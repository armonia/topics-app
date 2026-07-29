#!/usr/bin/env bun
/**
 * token-live — il consumo di una chat, dal vivo.
 *
 * Risponde a due domande che la UI, da sola, non mette mai una accanto all'altra:
 *
 *   1. Quanto sta CONSUMANDO questa chat (token letti dal modello, e in dollari),
 *      che è un totale cumulativo e cresce per sempre.
 *   2. Quanto è GRANDE il suo contesto adesso (l'ultima chiamata contro la
 *      finestra del modello), che è il numero del ring nel composer e sale e
 *      scende con le compattazioni.
 *
 * Sono grandezze diverse, e confonderle è il modo più rapido per guardare il
 * numero sbagliato: una sessione può stare al 35% di finestra e aver già letto
 * cinquanta milioni di token. Il primo numero è la bolletta, il secondo è il
 * serbatoio.
 *
 * Mostra anche quante volte il preambolo `<context>` è stato ri-iniettato: è la
 * verifica dal vivo della deduplicazione (`server/context/inline-sent-state.ts`).
 * A regime deve restare fermo mentre le chiamate salgono.
 *
 *   bun scripts/token-live.ts                 # tutte le chat con una sessione CLI
 *   bun scripts/token-live.ts armonia         # solo quelle che matchano
 *   bun scripts/token-live.ts armonia --watch # aggiorna finché non lo fermi
 *
 * Riusa i moduli veri del server (stesso dedup per message.id, stessa tabella
 * finestre, stessi moltiplicatori di cache), così non è una seconda verità.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranscriptUsageReader } from "../server/services/transcript-usage";
import { contextWindowFor, windowModelFor } from "../server/usage/context-window";
import { calculateCostWithCache } from "../server/usage/pricing";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const filter = args.find((a) => !a.startsWith("--"))?.toLowerCase() ?? "";
const INTERVAL_MS = 4000;

const dbPath = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "topics.db")
  : join(import.meta.dir, "..", "data", "topics.db");

if (!existsSync(dbPath)) {
  console.error(`Nessun DB in ${dbPath}. Passa DATA_DIR=… se il tuo sta altrove.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

interface Row {
  id: string;
  name: string;
  session_key: string;
  jsonl_path: string | null;
  phase: string | null;
  model: string | null;
}

function sessions(): Row[] {
  return db
    .prepare(
      `SELECT t.id, t.name, t.session_key, c.jsonl_path, c.phase, t.model
         FROM topics t
         JOIN claude_code_sessions c ON c.session_key = t.session_key
        WHERE c.jsonl_path IS NOT NULL AND t.archived = 0
        ORDER BY t.updated_at DESC`,
    )
    .all() as unknown as Row[];
}

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

/** Il modello che ha risposto per ultimo, e quante volte il preambolo è ripartito. */
function scanTranscript(path: string): {
  model: string | null;
  preambles: number;
  calls: number;
  lastCtx: number;
  /** Scritture di cache con TTL a un'ora: costano 2×, non 1.25×. */
  write1h: number;
} {
  let model: string | null = null;
  let preambles = 0;
  let calls = 0;
  let lastCtx = 0;
  let write1h = 0;
  const seen = new Set<string>();
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return { model, preambles, calls, lastCtx, write1h }; }

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }

    const content = j?.message?.content;
    const texts: string[] = typeof content === "string"
      ? [content]
      : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text) : [];
    for (const t of texts) if (typeof t === "string" && t.includes("<context>")) preambles++;

    const u = j?.message?.usage;
    if (!u) continue;
    const id = j.message?.id ?? j.requestId;
    if (id) {
      if (seen.has(id)) continue; // riga per content-block della stessa risposta
      seen.add(id);
    }
    // `<synthetic>` non è un modello: sono le righe che la CLI scrive per un
    // errore o un'interruzione, con usage tutto a zero. Prenderle come "ultima
    // chiamata" azzera il contesto e perde il nome del modello — il ring del
    // server è immune perché scarta le misure <= 0 (`recordSessionContext`),
    // questo script no.
    const rowModel: string | undefined = j.message?.model;
    if (rowModel === "<synthetic>") continue;
    calls++;
    if (rowModel) model = rowModel;
    lastCtx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    // Il TTL della scrittura è SCRITTO nell'usage, non va inferito: una scrittura
    // a un'ora costa 2x, una a cinque minuti 1.25x. Su una sessione reale erano
    // il 100% a un'ora, e tariffarle tutte a 1.25x sottostimava il conto del 17,6%.
    write1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  }
  return { model, preambles, calls, lastCtx, write1h };
}

const reader = createTranscriptUsageReader();
const previous = new Map<string, { read: number; preambles: number }>();

function render(): void {
  // Il filtro guarda anche il path del transcript: il nome di una chat spesso non
  // dice a che progetto appartiene ("Aggiorniamoci puliamo…"), ma il path sì.
  const rows = sessions().filter(
    (r) =>
      !filter ||
      r.name.toLowerCase().includes(filter) ||
      r.session_key.toLowerCase().includes(filter) ||
      (r.jsonl_path ?? "").toLowerCase().includes(filter),
  );
  if (rows.length === 0) {
    console.log(filter ? `Nessuna chat che matcha "${filter}".` : "Nessuna chat con una sessione CLI.");
    return;
  }

  const stamp = new Date().toLocaleTimeString("it-IT");
  console.log(`\n[1m${stamp}[0m  ${rows.length} chat`);
  console.log(
    "  " +
      pad("CHAT", 30) + pad("FASE", 13) + pad("CONTESTO ORA", 20) +
      pad("LETTI", 9) + pad("Δ", 9) + pad("COSTO", 10) + pad("PREAMBOLI", 11) + "CHIAMATE",
  );

  for (const r of rows) {
    if (!r.jsonl_path || !existsSync(r.jsonl_path)) continue;
    const usage = reader.read(r.jsonl_path);
    const scan = scanTranscript(r.jsonl_path);
    // `[1m]` è una MODALITÀ, non un modello: il picker la sceglie, la CLI negli
    // eventi riporta il nome nudo (`claude-opus-5`). Dimensionare la finestra sul
    // solo nome del transcript rifà il bug che `windowModelFor` esiste per
    // chiudere — 359k su 200k invece che su 1M, cioè un anello rosso al 180%
    // mentre la sessione è al 36%. Il modello richiesto sta su `topics.model`.
    const model = windowModelFor(scan.model, r.model) ?? "";
    const win = contextWindowFor(model);
    const pct = win.tokens > 0 ? (scan.lastCtx / win.tokens) * 100 : 0;

    // Tutto ciò che il modello ha LETTO: fresco + scrittura + rilettura di cache.
    // È la bolletta, ed è il numero che nessuna schermata somma per intero.
    const read = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
    const cost = calculateCostWithCache({
      model,
      freshInputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      // Quote DISGIUNTE: quel che non è a un'ora è a cinque minuti.
      cacheCreationTokens: Math.max(0, usage.cacheWriteTokens - scan.write1h),
      cacheCreation1hTokens: scan.write1h,
    });

    const prev = previous.get(r.session_key);
    const delta = prev ? read - prev.read : 0;
    const newPreamble = prev && scan.preambles > prev.preambles;
    previous.set(r.session_key, { read, preambles: scan.preambles });

    const ctxColor = pct > 90 ? "[31m" : pct > 70 ? "[33m" : "[36m";
    const ctxCell = `${ctxColor}${fmt(scan.lastCtx)}/${fmt(win.tokens)} ${pct.toFixed(0)}%[0m${win.known ? "" : " ≈"}`;
    // Il ring è "contesto vivo", questo è la stessa misura: se divergono, uno dei due mente.
    const deltaCell = delta > 0 ? `[32m+${fmt(delta)}[0m` : "·";
    const preCell = newPreamble ? `[33m${scan.preambles} ↑[0m` : String(scan.preambles);

    console.log(
      "  " +
        pad(r.name.replace(/\s+/g, " "), 30) +
        pad(r.phase ?? "?", 13) +
        ctxCell.padEnd(20 + ctxColor.length + 5) +
        pad(fmt(read), 9) +
        deltaCell.padEnd(9 + (delta > 0 ? 9 : 0)) +
        pad("$" + cost.toFixed(2), 10) +
        preCell.padEnd(11 + (newPreamble ? 9 : 0)) +
        String(scan.calls),
    );
  }

  console.log(
    "\n  [2mCONTESTO ORA = ultima chiamata / finestra (il ring del composer) · " +
      "LETTI = cumulativo fresco+cache (la bolletta)\n  PREAMBOLI = quante volte <context> è ripartito: " +
      "a regime resta fermo mentre CHIAMATE sale.[0m",
  );
}

render();
if (watch) {
  setInterval(render, INTERVAL_MS);
} else {
  db.close();
}
