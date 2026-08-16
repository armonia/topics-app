#!/usr/bin/env bun
/**
 * QUANTO CI METTE UN TURNO, misurato DAL SERVER VERO.
 *
 * PERCHÉ QUESTA È LA SECONDA VERSIONE. La prima istanziava i provider a mano in
 * questo processo: il runtime nativo rispondeva (non ha niente da spawnare),
 * `claude-code` restava appeso oltre dieci minuti senza emettere un token. Il
 * difetto era dell'harness, non della CLI — dentro Topics funziona benissimo —
 * e una tabella con una riga sola non è un confronto.
 *
 * Qui si chiede al SERVER, sulla strada che usano davvero una chat e la board:
 * `POST /api/chat` con `provider` scelto per turno. Stessa rotta, stesso
 * contesto, stesso streaming SSE. L'unica differenza fra le due righe è chi
 * serve il turno, che è esattamente la variabile in esame.
 *
 * COSA SI MISURA, e perché due numeri e non uno.
 *
 *   avvio    dalla richiesta al PRIMO token leggibile. È dove una CLI paga lo
 *            spawn di un processo Node e il suo boot, mentre il nativo paga la
 *            sola latenza di rete. È ciò che una persona sente come reattività.
 *   totale   fino a `[DONE]`. Qui domina il MODELLO, che è lo stesso per
 *            entrambi: differenze grandi qui sarebbero sospette, non vittorie.
 *
 * IL PRIMO TURNO SI RIPORTA SEPARATO, per non barare al contrario: la CLI paga
 * lo spawn UNA volta e poi tiene la sessione calda. Il primo turno è la verità
 * per un agente DISPACCIATO (nasce, lavora, muore); la mediana dei successivi è
 * la verità per una chat che continua.
 *
 * COSTA SOLDI VERI su entrambe le strade. Non gira dentro `bun run bench`.
 *
 * USAGE
 *   bun run scripts/bench/turn-time.ts --base https://127.0.0.1:39420
 *   bun run scripts/bench/turn-time.ts --base ... --turns 4 --only native
 */

import { writeFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const BASE = flag("base", "https://127.0.0.1:3333")!.replace(/\/$/, "");
const TURNS = Number(flag("turns", "3"));
const MODEL = flag("model");
const ONLY = flag("only");
/** Banale di proposito: si misura la STRADA, non il ragionamento. */
const PROMPT = "Rispondi con la sola parola PONG.";

/** Il server usa un certificato self-signed su loopback. */
const tls = { tls: { rejectUnauthorized: false } } as unknown as RequestInit;

interface Sample { startMs: number; totalMs: number; ok: boolean; note?: string }

function stats(xs: number[]) {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? { median: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s[s.length - 1]! } : { median: NaN, min: NaN, max: NaN };
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { ...tls, ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

/** Una topic nuova per ogni strada: le sessioni non si mescolano. */
async function freshTopic(name: string): Promise<string> {
  const t = await api("/api/topics", { method: "POST", body: JSON.stringify({ name }) });
  if (!t?.sessionKey) throw new Error(`topic non creata: ${JSON.stringify(t).slice(0, 200)}`);
  return t.sessionKey;
}

/**
 * Un turno sulla rotta vera, cronometrando il primo byte di testo.
 *
 * Si legge lo stream mentre arriva invece di aspettare la fine: il PRIMO token
 * è metà della misura, e `await res.text()` lo perderebbe.
 */
async function oneTurn(sessionKey: string, provider: string): Promise<Sample> {
  const t0 = performance.now();
  let first = 0;
  const res = await fetch(`${BASE}/api/chat`, {
    ...tls,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, provider, messages: [{ role: "user", content: PROMPT }], contextMode: "full", dispatched: true, ...(MODEL ? { model: MODEL } : {}) }),
  });
  if (!res.ok || !res.body) {
    return { startMs: NaN, totalMs: performance.now() - t0, ok: false, note: `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let sawText = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    // Il primo `delta.content` con del testo dentro: i frame di apertura non
    // sono un token leggibile, e contarli darebbe un avvio più bello del vero.
    if (!sawText && /"content":"[^"]/.test(chunk)) { first = performance.now(); sawText = true; }
  }
  return { startMs: first ? first - t0 : NaN, totalMs: performance.now() - t0, ok: sawText };
}

async function measure(provider: string): Promise<Sample[]> {
  const key = await freshTopic(`bench ${provider} ${Date.now()}`);
  const out: Sample[] = [];
  for (let i = 0; i < TURNS; i++) out.push(await oneTurn(key, provider));
  return out;
}

function report(label: string, xs: Sample[]) {
  const ok = xs.filter((s) => s.ok);
  if (ok.length === 0) {
    console.log(`${label.padEnd(12)} nessun turno riuscito${xs[0]?.note ? ` — ${xs[0].note}` : ""}`);
    return null;
  }
  const f = ok[0]!;
  const rest = ok.slice(1);
  const s = stats(rest.map((x) => x.startMs));
  const t = stats(rest.map((x) => x.totalMs));
  console.log(
    `${label.padEnd(12)} 1°: avvio ${f.startMs.toFixed(0).padStart(6)} ms  totale ${f.totalMs.toFixed(0).padStart(6)} ms` +
    (rest.length ? `   |  poi (mediana ${rest.length}): avvio ${s.median.toFixed(0).padStart(6)} ms  totale ${t.median.toFixed(0).padStart(6)} ms` : "") +
    `   [${ok.length}/${xs.length} ok]`,
  );
  return { label, firstStartMs: f.startMs, firstTotalMs: f.totalMs, medianStartMs: s.median, medianTotalMs: t.median, ok: ok.length, attempted: xs.length };
}

console.log(`\nserver ${BASE}, ${TURNS} turni per strada${MODEL ? `, modello ${MODEL}` : ""}\nprompt «${PROMPT}»\n`);

const rows: unknown[] = [];
for (const p of ["topics", "claude-code"]) {
  if (ONLY && ONLY !== p && !(ONLY === "native" && p === "topics") && !(ONLY === "cli" && p === "claude-code")) continue;
  const label = p === "topics" ? "native" : "cli";
  try { const r = report(label, await measure(p)); if (r) rows.push(r); }
  catch (err) { console.log(`${label.padEnd(12)} non misurato — ${err instanceof Error ? err.message : String(err)}`); }
}

const outPath = join(import.meta.dir, "..", "..", "bench", "results", "turn-time-latest.json");
writeFileSync(outPath, JSON.stringify({
  schema: "bench-turn-time-v2",
  measured_at: new Date().toISOString(),
  base: BASE,
  model: MODEL ?? "(default del provider)",
  turns: TURNS,
  prompt: PROMPT,
  how: "POST /api/chat sul server vero, con `provider` scelto per turno: la stessa rotta di una chat e della board. L'unica differenza fra le righe è chi serve il turno.",
  caveats: [
    "Chiama il modello VERO su entrambe le strade: questo run è costato soldi.",
    "Il TOTALE è dominato dal modello, uguale per entrambi: differenze grandi lì sono sospette, non vittorie.",
    "Il 1° turno è la verità per un agente dispacciato (nasce, lavora, muore); la mediana dei successivi è quella di una chat che continua.",
    "La CLI paga lo spawn una volta sola e poi tiene la sessione calda: confrontare solo il primo turno le darebbe torto in modo sleale.",
    "Il modello di default può differire fra i due provider: passare --model per fissarlo se il confronto deve essere stretto.",
  ],
  rows,
}, null, 2));
console.log(`\nscritto ${outPath}\n`);
