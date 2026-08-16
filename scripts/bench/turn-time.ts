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
 * DUE CARICHI, e il secondo è quello che la board fa davvero.
 *
 *   ping     una domanda banale, zero tool. Isola la STRADA: quanto costa
 *            arrivare al modello e tornare indietro.
 *   work     leggi un file, modificalo, rileggilo. È il turno di un agente
 *            vero, dove il tool loop gira davvero. Su questo carico il tempo
 *            del modello cresce e il vantaggio della strada si comprime:
 *            misurare solo `ping` racconterebbe il caso più favorevole.
 *
 * COSTA SOLDI VERI su entrambe le strade. Non gira dentro `bun run bench`.
 *
 * USAGE
 *   bun run scripts/bench/turn-time.ts --base https://127.0.0.1:39420
 *   bun run scripts/bench/turn-time.ts --base ... --turns 4 --only native
 */

import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const BASE = flag("base", "https://127.0.0.1:3333")!.replace(/\/$/, "");
const TURNS = Number(flag("turns", "3"));
const MODEL = flag("model");
const ONLY = flag("only");
const LOAD = flag("load", "ping")!;

/**
 * I due carichi. `ping` è banale di proposito (si misura la strada, non il
 * ragionamento); `work` fa lavorare il tool loop come in un task vero.
 */
const PROMPTS: Record<string, string> = {
  ping: "Rispondi con la sola parola PONG.",
  work:
    "Nel file bench.txt: leggilo, sostituisci il suo contenuto con la parola FATTO, " +
    "poi rileggilo per confermare. Usa gli strumenti, poi fermati.",
};
const PROMPT = PROMPTS[LOAD] ?? PROMPTS.ping!;

/**
 * La directory su cui il carico `work` lavora. Creata qui e buttata alla fine:
 * un bench che sporca un progetto vero è un bench che si smette di lanciare.
 */
const WORKDIR = LOAD === "work" ? mkdtempSync(join(tmpdir(), "bench-work-")) : undefined;

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

/**
 * Il modello che ogni provider userebbe ADESSO, chiesto allo snapshot.
 *
 * ESISTE PERCHÉ IL BENCH HA GIÀ MENTITO UNA VOLTA. Senza `--model` i due
 * provider prendono il PROPRIO default, e su questa macchina erano
 * `claude-opus-5[1m]` per la CLI e `claude-sonnet-4-6` per il nativo: il primo
 * confronto pubblicato metteva Opus contro Sonnet e chiamava «differenza di
 * strada» una differenza di modello.
 *
 * Peggio: passare `--model` non basta. La rotta SCARTA un override che il
 * provider non offre (`chat.ts`, «Dropping stale model override») e lo fa in
 * silenzio verso il chiamante — quindi un `--model haiku` sembrava applicato e
 * lasciava la CLI su Opus. L'unico modo di saperlo è chiedere PRIMA quali
 * modelli offre ciascuno.
 */
async function defaultModels(): Promise<Record<string, { model?: string; models: string[] }>> {
  const snap = await api("/api/providers/snapshot");
  const rows: any[] = Array.isArray(snap) ? snap : (snap?.providers ?? []);
  const out: Record<string, { model?: string; models: string[] }> = {};
  for (const p of rows) out[p.name] = { model: p.defaultModel, models: p.models ?? [] };
  return out;
}

/**
 * Una topic nuova per ogni strada: le sessioni non si mescolano.
 *
 * Col carico `work` serve anche un PROGETTO: senza, il runtime nativo non
 * offre i tool di file (è la sua regola: nessuna workspace, nessuno strumento)
 * e si misurerebbe una chat invece di un agente. La CLI lo userebbe come cwd.
 */
async function freshTopic(name: string, projectPath?: string): Promise<string> {
  const t = await api("/api/topics", { method: "POST", body: JSON.stringify({ name }) });
  if (!t?.sessionKey) throw new Error(`topic non creata: ${JSON.stringify(t).slice(0, 200)}`);
  if (projectPath) {
    await api(`/api/topics/${t.id}`, { method: "PATCH", body: JSON.stringify({ projectPath }) });
  }
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
  const key = await freshTopic(`bench ${provider} ${Date.now()}`, WORKDIR);
  const out: Sample[] = [];
  for (let i = 0; i < TURNS; i++) {
    // Il file torna al punto di partenza prima di ogni turno: altrimenti dal
    // secondo giro l'agente lo trova già a posto e non fa il lavoro che stiamo
    // cronometrando.
    if (LOAD === "work" && WORKDIR) writeFileSync(join(WORKDIR, "bench.txt"), "prima\n");
    out.push(await oneTurn(key, provider));
  }
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

// IL CANCELLO: si guarda cosa userebbe ciascuno PRIMA di cronometrare.
const snap = await defaultModels();
const effective: Record<string, string> = {};
for (const p of ["topics", "claude-code"]) {
  const info = snap[p];
  if (!info) continue;
  // Un override che il provider non offre viene scartato dalla rotta in
  // silenzio: qui si sa in anticipo, e si dice quale modello girerà davvero.
  const applied = MODEL && info.models.length > 0 && !info.models.includes(MODEL) ? undefined : MODEL;
  effective[p] = applied ?? info.model ?? "(sconosciuto)";
  if (MODEL && !applied) {
    console.log(`  ! ${p}: «${MODEL}» non è fra i suoi modelli — userà ${effective[p]}`);
  }
}
const models = [...new Set(Object.values(effective))];
if (models.length > 1) {
  console.log(`\n  ATTENZIONE: le due strade girerebbero su modelli DIVERSI (${Object.entries(effective).map(([k, v]) => `${k}=${v}`).join(", ")}).`);
  console.log(`  Questo non è un confronto di strade: è un confronto di modelli. Passare --model con uno che offrano entrambi.\n`);
} else {
  console.log(`  modello effettivo su entrambe le strade: ${models[0]}\n`);
}

const rows: unknown[] = [];
for (const p of ["topics", "claude-code"]) {
  if (ONLY && ONLY !== p && !(ONLY === "native" && p === "topics") && !(ONLY === "cli" && p === "claude-code")) continue;
  const label = p === "topics" ? "native" : "cli";
  try { const r = report(label, await measure(p)); if (r) rows.push(r); }
  catch (err) { console.log(`${label.padEnd(12)} non misurato — ${err instanceof Error ? err.message : String(err)}`); }
}

// Un file PER CARICO: `ping` e `work` rispondono a due domande diverse, e
// scriverli sullo stesso nome significa che l'ultimo run cancella l'altra
// metà della storia — che è esattamente come si perde il numero che serviva.
const outPath = join(import.meta.dir, "..", "..", "bench", "results", `turn-time-${LOAD}.json`);

// UN RUN FALLITO NON CANCELLA UNA MISURA BUONA, e questa riga esiste perché è
// già successo: un `--base` sbagliato ha scritto una tabella vuota sopra il
// confronto appena pubblicato. Un bench che perde il dato quando la connessione
// cade è un bench di cui non ci si fida.
if (rows.length === 0) {
  console.log(`\nnessuna riga misurata: ${outPath} lasciato com'era.\n`);
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify({
  schema: "bench-turn-time-v2",
  measured_at: new Date().toISOString(),
  base: BASE,
  model_requested: MODEL ?? null,
  model_effective: effective,
  same_model: models.length === 1,
  load: LOAD,
  turns: TURNS,
  prompt: PROMPT,
  how: "POST /api/chat sul server vero, con `provider` scelto per turno: la stessa rotta di una chat e della board. L'unica differenza fra le righe è chi serve il turno.",
  caveats: [
    "Chiama il modello VERO su entrambe le strade: questo run è costato soldi.",
    "Il TOTALE è dominato dal modello, uguale per entrambi: differenze grandi lì sono sospette, non vittorie.",
    "Il 1° turno è la verità per un agente dispacciato (nasce, lavora, muore); la mediana dei successivi è quella di una chat che continua.",
    "La CLI paga lo spawn una volta sola e poi tiene la sessione calda: confrontare solo il primo turno le darebbe torto in modo sleale.",
    "Il modello di default può differire fra i due provider: passare --model per fissarlo se il confronto deve essere stretto.",
    "CARICO `work`: l'AVVIO non è confrontabile fra le due strade. Il primo token leggibile arriva quando l'agente PARLA, e i due agenti parlano in momenti diversi — la CLI premette una frase prima di usare gli strumenti, il runtime nativo va dritto al primo tool e parla dopo. Su questo carico si legga il TOTALE, che è la stessa domanda per entrambi: quando è finito il lavoro.",
    "CARICO `work`: il vantaggio si comprime (~1,2x contro i ~2,8x di `ping`), ed è atteso — il tempo del modello e dei tool è lo stesso per entrambi, quindi il costo della strada pesa in proporzione meno. È il numero onesto per un task vero.",
  ],
  rows,
}, null, 2));
console.log(`\nscritto ${outPath}\n`);
if (WORKDIR) { try { rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* scratch */ } }
