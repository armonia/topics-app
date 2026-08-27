/**
 * LA DECOMPOSIZIONE: dove vanno i token di prompt di un braccio del banco, e
 * perché il conto chiude al 100% invece che per residuo.
 *
 * ── L'aritmetica ────────────────────────────────────────────────────────────
 * Il contesto di una sessione non è una lista di pezzi: è una lista di pezzi
 * MOLTIPLICATA per quante volte viene riletta. Chiamiamo C(k) il prompt della
 * k-esima richiesta — `input + cache_read + cache_creation`, che è quello che si
 * paga davvero. Allora:
 *
 *     S(1) = C(1)                      il primo blocco: prefisso + prompt utente
 *     S(k) = C(k) − C(k−1)   (k > 1)   quel che è stato appeso dopo la richiesta k−1
 *
 * S(k) esiste dalla richiesta k in poi, quindi la sua quota della sessione è
 * `S(k) × (N − k + 1)`. La somma di quelle quote è la somma dei C(k), cioè il
 * numero che il banco stampa. Non è una stima: è una riscrittura, e lo script
 * ESCE NON-ZERO se non torna al token.
 *
 * ── Perché questo non è il metodo della sessione reale ───────────────────────
 * Su un transcript vero (`project_dove-vanno-i-token-davvero`) il thinking non
 * c'è — i blocchi arrivano vuoti, con la sola firma — e il suo volume si ricava
 * per RESIDUO su una calibrazione. Qui no: la sessione è controllata, gli
 * `output_tokens` definitivi si leggono dal `message_delta` di ogni richiesta, e
 * `output_tokens_details.thinking_tokens` dice quanto di quello era thinking.
 * Quindi ogni segmento si divide in «risposta dell'assistant riletta» (esatta) e
 * «risultato del tool» (il resto del segmento, che include l'incorniciatura dei
 * messaggi — qualche decina di token).
 *
 * ── Il primo blocco, che l'aritmetica da sola non apre ──────────────────────
 * S(1) è `prefisso + prompt utente` fusi. Si separano solo misurando il prefisso
 * a parte: `prefix-probe.ts` gira la stessa CLI con un prompt di una parola. Se
 * `probe-results.json` c'è, questo script lo usa; se non c'è, dichiara S(1)
 * indiviso invece di indovinare.
 *
 * E il prefisso NON è lo stesso nei due bracci, che è la cosa che questo script
 * ha trovato per prima: il braccio OFF è partito con 30 tool dichiarati, quello
 * ON con 35 — misurati ~5.400 token di differenza su OGNI richiesta. Quindi il
 * prefisso si ricava per BRACCIO (`C(1) − prompt utente`, dove il prompt utente
 * è lo stesso testo nei due) e la sonda serve da controprova, non da valore.
 *
 *     bun scripts/mcp-cap-bench/decompose.ts [--arm off|on] [--json]
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR } from "./pages";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const ARMS = (flag("--arm") ? [flag("--arm")!] : ["off", "on"]) as ("off" | "on")[];
const AS_JSON = argv.includes("--json");

interface Request {
  /** Token di prompt della richiesta: `input + cache_read + cache_creation`. */
  context: number;
  /** Output DEFINITIVO — dal `message_delta`. Gli eventi `assistant` sono snapshot. */
  output: number;
  /** Quanto di quell'output era thinking (0 quando l'effort non ne produce). */
  thinking: number;
  /** Cosa ha prodotto la richiesta: serve solo a dare un nome al segmento dopo. */
  produced: string;
}

interface Segment {
  /** Da quale richiesta in poi questo blocco sta nel contesto (1-based). */
  from: number;
  label: string;
  tokens: number;
  /** Riletture: `N − from + 1`. */
  times: number;
  /** `tokens × times` — la quota vera. */
  weight: number;
}

/**
 * Legge lo stream-json di un braccio. Due sole avvertenze, entrambe già costate
 * un errore: l'usage va preso dal `message_delta` (gli eventi `assistant` sono
 * snapshot a metà generazione: `out=4` su 98), e i `tool_result` stanno negli
 * eventi `user`, non nell'assistant che li ha chiesti.
 */
function readArm(path: string) {
  const requests: Request[] = [];
  const toolResults: string[] = [];
  /** Nome del tool chiamato, per etichettare il segmento che ne è seguito. */
  const called: string[] = [];
  let totalFromResult: number | null = null;
  /**
   * Quanti tool la CLI dichiarava all'avvio. Quelli aggiunti DOPO non passano
   * dallo stream-json (stanno nel transcript della CLI, come
   * `deferred_tools_delta`): qui si vede solo il loro effetto, cioè un segmento
   * che cresce più di quanto pesi il `tool_result` che l'ha causato.
   */
  let toolsAtBoot = 0;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }

    if (ev.type === "stream_event" && ev.event?.type === "message_delta") {
      const u = ev.event.usage ?? {};
      requests.push({
        context: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
        produced: "",
      });
    }
    if (ev.type === "system" && ev.subtype === "init") toolsAtBoot = (ev.tools ?? []).length;
    if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "tool_use") called.push(b.name);
      }
    }
    if (ev.type === "user") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "tool_result") {
          toolResults.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
        }
      }
    }
    if (ev.type === "result") {
      const u = ev.usage ?? {};
      // `result.usage` è la SOMMA sulle richieste: è la controprova indipendente
      // che la lettura per `message_delta` non ha perso né contato due volte.
      totalFromResult =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  // Un `tool_use` per richiesta nel banco: l'accoppiamento è posizionale e la
  // lunghezza si controlla sotto invece di assumerla.
  requests.forEach((r, i) => { r.produced = called[i] ?? "risposta finale"; });
  return { requests, toolResults, totalFromResult, toolsAtBoot };
}

function decompose(arm: "off" | "on") {
  const path = join(BENCH_DIR, `stream-${arm}.jsonl`);
  if (!existsSync(path)) return null;
  const { requests, toolResults, totalFromResult, toolsAtBoot } = readArm(path);
  const N = requests.length;
  if (!N) return null;

  const total = requests.reduce((s, r) => s + r.context, 0);
  const segments: Segment[] = [];

  segments.push({
    from: 1,
    label: "prefisso + prompt utente",
    tokens: requests[0]!.context,
    times: N,
    weight: requests[0]!.context * N,
  });

  for (let k = 2; k <= N; k++) {
    const grown = requests[k - 1]!.context - requests[k - 2]!.context;
    const echoed = requests[k - 2]!.output; // l'output della richiesta k−1, ora riletto
    const rest = grown - echoed;
    const times = N - k + 1;
    const what = requests[k - 2]!.produced;
    // Il segmento che segue un `ToolSearch` non è solo lo schema materializzato:
    // è tutto ciò che la CLI ha appeso al primo giro di tool, registro compreso.
    // Nel braccio OFF sono 4.798 token per un `tool_result` da 63 caratteri; nel
    // braccio ON, che era già partito con il registro pieno, sono 143.
    const label = what === "ToolSearch" ? "primo giro di tool (schema + crescita del registro)" : `risultato di ${what}`;
    segments.push({ from: k, label: `risposta dell'assistant #${k - 1}`, tokens: echoed, times, weight: echoed * times });
    segments.push({ from: k, label, tokens: rest, times, weight: rest * times });
  }

  const sum = segments.reduce((s, x) => s + x.weight, 0);
  return { arm, N, total, totalFromResult, segments, sum, requests, toolResults, toolsAtBoot };
}

/** Le voci che interessano leggere, non i 24 segmenti uno per uno. */
function rollup(d: NonNullable<ReturnType<typeof decompose>>) {
  const q = (pred: (s: Segment) => boolean) => d.segments.filter(pred).reduce((s, x) => s + x.weight, 0);
  return {
    primoBlocco: q((s) => s.from === 1),
    rispostaAssistant: q((s) => s.label.startsWith("risposta dell'assistant")),
    risultatiTool: q((s) => s.label.startsWith("risultato di")),
    primoGiro: q((s) => s.label.startsWith("primo giro di tool")),
  };
}

const pct = (x: number, tot: number) => `${((x / tot) * 100).toFixed(1)}%`;
const it = (n: number) => n.toLocaleString("it-IT");

/**
 * Le sonde, indicizzate per quanti tool aveva la CLI quando sono girate: il
 * prefisso dipende da QUEL numero, e ignorarlo è come misurare due bracci con
 * due preamboli diversi e chiamarla differenza.
 *
 * Il prompt della sonda è «Rispondi con una sola parola: ok» — una manciata di
 * token che qui NON si tolgono: il prefisso è quindi noto a ±10 token, e serve
 * solo come controprova di un numero che si ricava altrimenti.
 */
const probePath = join(BENCH_DIR, "probe-results.json");
const sonde = new Map<number, number>();
if (existsSync(probePath)) {
  for (const p of JSON.parse(readFileSync(probePath, "utf8")).probes ?? []) {
    if (p.toolSearch === "1" && p.toolCount && p.contexts?.[0]) sonde.set(p.toolCount, p.contexts[0]);
  }
}

/**
 * Il prompt utente è lo STESSO testo nei due bracci, quindi si misura una volta
 * dove c'è una sonda con lo stesso registro di tool, e poi vale per entrambi.
 * Senza sonda non si divide niente: si dichiara il primo blocco indiviso.
 */
const misure = ARMS.map(decompose);
let promptUser: number | null = null;
for (const d of misure) {
  if (!d) continue;
  const sonda = sonde.get(d.toolsAtBoot);
  if (sonda != null) { promptUser = d.requests[0]!.context - sonda; break; }
}

const out: any[] = [];
let bad = false;

for (const d of misure) {
  if (!d) { console.error("manca uno stream-*.jsonl — gira prima il banco"); bad = true; continue; }
  const r = rollup(d);
  const prefisso = promptUser == null ? null : d.requests[0]!.context - promptUser;
  out.push({ ...d, rollup: r, prefisso, promptUser });

  if (AS_JSON) continue;
  console.log(`\n══ braccio ${d.arm.toUpperCase()} — ${it(d.total)} token di prompt su ${d.N} richieste`);
  console.log(
    `   contesto: ${it(d.requests[0]!.context)} alla prima richiesta → ${it(d.requests[d.N - 1]!.context)} all'ultima` +
      `  ·  ${d.toolsAtBoot} tool dichiarati all'avvio`,
  );
  console.log("");
  const row = (label: string, v: number) => console.log(`   ${pct(v, d.total).padStart(6)}  ${it(v).padStart(9)}  ${label}`);

  if (prefisso != null) {
    row(`PREFISSO × ${d.N} richieste (prompt di sistema + schemi + elenchi)`, prefisso * d.N);
    row(`prompt utente × ${d.N} richieste`, promptUser! * d.N);
  } else {
    row(`primo blocco (prefisso + prompt utente) × ${d.N} richieste`, r.primoBlocco);
    console.log("            (nessuna sonda con questo registro: il primo blocco resta indiviso)");
  }
  row("risultati dei tool, riletti", r.risultatiTool);
  if (r.primoGiro) row("primo giro di tool (schema materializzato + crescita del registro)", r.primoGiro);
  row("risposte dell'assistant, rilette", r.rispostaAssistant);
  const thinking = d.requests.reduce((s, x) => s + x.thinking, 0);
  console.log(`\n   thinking generato in tutta la sessione: ${it(thinking)} token ` +
    `(su ${it(d.requests.reduce((s, x) => s + x.output, 0))} di output)`);
  const sonda = sonde.get(d.toolsAtBoot);
  if (prefisso != null && sonda != null) {
    console.log(`   controprova: la sonda a ${d.toolsAtBoot} tool dice ${it(sonda)} — scarto ${it(Math.abs(sonda - prefisso))} token`);
  }

  // ── Il cancello: se la somma delle quote non È il totale, il metodo è rotto.
  const closes = d.sum === d.total;
  const crossChecks = d.totalFromResult == null || d.totalFromResult === d.total;
  console.log(
    `\n   chiusura: ${it(d.sum)} / ${it(d.total)} = ${((d.sum / d.total) * 100).toFixed(3)}% ` +
      `${closes ? "✓" : "✗"}${d.totalFromResult != null ? `  ·  controprova su result.usage: ${crossChecks ? "✓" : `✗ (${it(d.totalFromResult)})`}` : ""}`,
  );
  if (!closes || !crossChecks) bad = true;
}

if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  const p = join(BENCH_DIR, "decomposition.json");
  writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n   dettaglio segmento per segmento → ${p}`);
}
if (bad) process.exit(1);
