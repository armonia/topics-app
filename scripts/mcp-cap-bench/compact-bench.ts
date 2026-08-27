/**
 * LA BARRA DELLA CARD: la stessa sessione, la stessa sequenza di chiamate, una
 * volta con una soglia di compattazione e una volta senza — e i token di prompt
 * contati da quello che dice la CLI.
 *
 * ── Cosa risponde ───────────────────────────────────────────────────────────
 * La card diceva: «se il contesto supera una soglia bassa (ordine dei 100k)
 * conviene compattare anche a finestra piena al 30%». Il controfattuale sulle
 * sessioni vere (`compact-sim.ts`) dice che a 100k il conto in DOLLARI peggiora
 * del 39%, e che il minimo sta a 200k. Questo banco lo verifica sul vivo, dove
 * a rispondere è il modello e non l'aritmetica: la stessa sequenza, e alla fine
 * la stessa domanda, di cui la risposta deve restare ESATTA.
 *
 * ── Cosa ha risposto, sul vivo (12/08, cap 25.000, bundle 1, 5 per turno) ───
 * Quattro bracci, stessa sequenza, `claude-opus-5[1m]`, marcatori esatti in
 * tutti e quattro. Il verdetto dipende da DOVE si ferma la sessione:
 *
 *              picco    token                dollari
 *   15 fetch   122k     -17,9%               +25,5%   compattare COSTA
 *   30 fetch   215k     -47,1%               -10,9%   compattare rende
 *
 * Le due righe non si contraddicono: il risparmio in token è quasi tutto
 * risparmio di cache-read, che si paga 0,1×, mentre ogni compattazione rifà il
 * prefisso a 1,25×. Sotto i 150k il secondo conto batte il primo, e la soglia
 * peggiora il totale pur avendo tagliato un quinto dei token. Il sorpasso, sul
 * costo cumulato per fase della corsa a 30, cade fra la 20ª e la 25ª fetch:
 * contesto di controllo fra 152k e 185k, cioè dove il controfattuale sulle 351
 * sessioni lo dava. Il disegno è in `soglia-viva.svg`.
 *
 * ── Perché a più turni ──────────────────────────────────────────────────────
 * Una compattazione non si può infilare a metà di un turno: `/compact` è un
 * messaggio, e i messaggi si mandano fra un turno e l'altro. Quindi la sessione
 * è spezzata in turni da poche fetch ciascuno, ripresi con `--resume` — che è
 * esattamente come Topics parla alla CLI in produzione (`buildClaudeArgs`,
 * `isNewSession: false`). Fra un turno e l'altro il banco guarda il contesto e,
 * se il braccio ha una soglia e il contesto l'ha superata, manda `/compact`.
 *
 * ── I due modi in cui questo banco può bocciare la soglia ───────────────────
 *  • il CONTO: se i token scendono ma i dollari salgono, la soglia ha spostato
 *    il costo dalla cache (0,1×) alla scrittura (1,25×) e non ha risparmiato
 *    niente. È il motivo per cui qui si conta il denaro e non solo i token;
 *  • la RISPOSTA: alla fine si chiedono due marcatori che stanno dentro pagine
 *    scaricate PRIMA della compattazione. Se il taglio se li è portati via, la
 *    sessione dovrà rifare il lavoro — e quel costo, che il controfattuale non
 *    sa vedere, qui si vede tutto.
 *
 *     bun scripts/mcp-cap-bench/compact-bench.ts --soglia 100000
 *     bun scripts/mcp-cap-bench/compact-bench.ts --soglia off
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { buildClaudeArgs } from "../../server/providers/claude/args";
import { calculateCostWithCache } from "../../server/usage/pricing";
import { PAGES, BENCH_DIR, markerFor } from "./pages";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const MODEL = flag("--model", "claude-opus-5[1m]")!;
/** `off` = il braccio di controllo, quello che non compatta mai. */
const THRESHOLD_RAW = flag("--soglia", "off")!;
const SOGLIA = THRESHOLD_RAW === "off" ? null : Number(THRESHOLD_RAW);
/** Quante fetch in tutto. La card ne chiede 20. */
const FETCH = Number(flag("--fetch", "20"));
/** Quante per turno: più corto il turno, più fitto il controllo sulla soglia. */
const PER_TURN = Number(flag("--per-turno", "5"));
/**
 * Il tetto ai risultati MCP, uguale nei due bracci. Si passa SEMPRE esplicito, e
 * il valore di default non è più `0`.
 *
 * `--cap 0` vuol dire «nessun override», e sembra la scelta neutra. Non lo è: la
 * CLI senza `MAX_MCP_OUTPUT_TOKENS` non applica il default da 25.000 token che
 * ha documentato, versa su disco anche UNA pagina sola. Misurato il 12/08 alle
 * 23, stessa sequenza a `--bundle 1` (pagine da 8-18 KB):
 *
 *     --cap 0      contesto 29k dopo 5 fetch, e i 30 risultati sono TUTTI lo
 *                  stub «result (8.608 characters) exceeds maximum allowed
 *                  tokens. Output has been saved to …» (1,4 KB l'uno)
 *     --cap 25000  contesto 59k dopo le stesse 5 fetch: le pagine ci sono
 *
 * Il banco a `--cap 0` misurava quindi una sessione di STUB: girava, tornava
 * verde, i marcatori tornavano (il modello rileggeva i file da disco) e non
 * misurava niente di ciò che la card chiede. È il motivo del controllo qui
 * sotto, che ora ALZA invece di lasciar passare.
 */
const CAP = Number(flag("--cap", "25000"));
const ARM = SOGLIA == null ? "senza" : `${Math.round(SOGLIA / 1000)}k`;
const OUT = join(BENCH_DIR, `compact-${ARM}.json`);
const LOG = join(BENCH_DIR, `compact-${ARM}.jsonl`);

/**
 * Quante pagine per risultato. NON è la manopola del contesto grasso: quella è
 * `--cap`. Un pacchetto da quattro pagine (57-66 KB) supera il tetto e finisce
 * su disco esattamente come lo superava la pagina singola a `--cap 0`.
 */
const BUNDLE = Number(flag("--bundle", "4"));

/** Le due pagine di cui si chiede il marcatore: scaricate presto, quindi a rischio taglio. */
const ASK = [2, 4];

/** La sequenza di URL: le 10 pagine a giro, ognuna come pacchetto da `BUNDLE`. */
function urls(): string[] {
  const out: string[] = [];
  for (let i = 0; i < FETCH; i++) {
    const page = PAGES[i % PAGES.length]!;
    out.push(BUNDLE > 1 ? `${page}?bundle=${BUNDLE}` : page);
  }
  return out;
}

interface TurnResult {
  /** Il contesto di ogni richiesta del turno, dai `message_delta`. */
  contexts: number[];
  cacheRead: number;
  cacheCreate: number;
  fresh: number;
  output: number;
  text: string;
  /** Quanti risultati di tool la CLI ha versato su disco invece di lasciarli in contesto. */
  suDisco: number;
  /** Il turno ha attraversato una compattazione (evento `compact_boundary`). */
  compattato: boolean;
}

/** Le tre facce dello stesso guasto: il risultato non è in contesto, è un puntatore. */
const ON_DISK = /exceeds maximum allowed tokens|Output has been saved to|persisted-output/;

/**
 * La HOME finta è per BRACCIO, non una sola per il banco. I due bracci si
 * girano volentieri in parallelo (stesso provider, stessa ora: è il modo di non
 * farsi confondere da un 529 che capita a metà del secondo), e due CLI vive
 * nella stessa HOME si scrivono addosso lo stato di sessione, la cronologia e i
 * file di telemetria. La cartella costa niente; una corsa da rifare sì.
 */
function prepareHome(): string {
  const home = join(tmpdir(), `compact-bench-home-${ARM}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const cred = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(cred)) copyFileSync(cred, join(home, ".claude", ".credentials.json"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }) + "\n",
  );
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({}) + "\n");
  return home;
}

function mcpConfig(): string {
  const p = join(BENCH_DIR, "compact-mcp-config.json");
  writeFileSync(
    p,
    JSON.stringify(
      {
        mcpServers: {
          bench: {
            type: "stdio",
            command: process.execPath,
            args: [join(import.meta.dir, "fake-web-mcp.ts")],
            env: { TOPICS_BENCH_DIR: BENCH_DIR },
          },
        },
      },
      null,
      2,
    ),
  );
  return p;
}

/**
 * Il turno, con i ritenti — e con la regola su QUANDO si può ritentare.
 *
 * Il 529 del provider è passeggero: il 12/08 le corse morivano a metà per
 * sovraccarico, e un banco che si arrende al primo non finisce mai. Ma un turno
 * si può rifare solo se non è successo NIENTE: se qualche richiesta era già
 * arrivata al modello, la sessione ha già mosso lo stato e rigiocarla conterebbe
 * due volte le stesse fetch. In quel caso si molla, e si dice perché.
 */
async function turnConRitenti(
  text: string,
  sessionId: string,
  isNew: boolean,
  home: string,
  cfg: string,
  tentativi = 5,
): Promise<TurnResult> {
  let ultimo: Error | null = null;
  for (let k = 0; k < tentativi; k++) {
    try {
      return await turn(text, sessionId, isNew, home, cfg);
    } catch (err) {
      ultimo = err as Error;
      if (!/non è successo niente/.test(ultimo.message)) throw ultimo;
      const attesa = 20_000 * (k + 1);
      console.log(`   … turno fallito (${ultimo.message.slice(0, 80)}), riprovo fra ${attesa / 1000}s`);
      await new Promise((r) => setTimeout(r, attesa));
    }
  }
  throw ultimo ?? new Error("turno fallito");
}

/**
 * Un turno: si spawna la CLI, si manda UN messaggio, si legge fino a `result`.
 *
 * Il contesto per richiesta si legge dai `message_delta` e non dagli eventi
 * `assistant`, che sono snapshot a metà generazione — la stessa trappola che
 * `decompose.ts` si porta scritta in testa.
 */
async function turn(
  text: string,
  sessionId: string,
  isNew: boolean,
  home: string,
  cfg: string,
): Promise<TurnResult> {
  const args = buildClaudeArgs({
    permissionMode: "bypassPermissions",
    model: MODEL,
    mcpConfigPath: cfg,
    mcpStrict: true,
    permissionPromptTool: "mcp__bench__noop",
    appendSystemPrompt: "Banco di misura: esegui alla lettera, non commentare.",
    claudeSessionId: sessionId,
    isNewSession: isNew,
    toolSearch: "1",
    mcpOutputTokens: CAP > 0 ? CAP : null,
  });
  const child = spawn("claude", args, {
    cwd: BENCH_DIR,
    env: { ...process.env, HOME: home, CLAUDE_CODE_ENTRYPOINT: "bench" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
  );

  const res: TurnResult = {
    contexts: [], cacheRead: 0, cacheCreate: 0, fresh: 0, output: 0, text: "", suDisco: 0, compattato: false,
  };
  /**
   * Il totale del turno secondo la CLI: l'unico conto che esista sul turno di
   * `/compact`. Non è `... | null` perché lo riempie una callback, e l'analisi
   * di flusso di TS non la vede: fuori resterebbe `null` per sempre.
   */
  const daResult = { fresh: 0, read: 0, create: 0, out: 0, visto: false };
  let apiError = "";
  // Lo stderr va LETTO, per due motivi: quando la CLI muore prima di parlare la
  // ragione sta solo lì, e una pipe che nessuno svuota si riempie e blocca il
  // processo figlio a metà turno.
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  let buf = "";
  await new Promise<void>((resolve) => {
    // Un turno che non chiude non deve appendere il banco per sempre: si taglia
    // e il conto lo dice, invece di restare a guardare un processo muto.
    const bail = setTimeout(() => { child.kill(); resolve(); }, 900_000);
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        appendFileSync(LOG, line + "\n");
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "stream_event" && ev.event?.type === "message_delta") {
          const u = ev.event.usage ?? {};
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const cacheCreate = u.cache_creation_input_tokens ?? 0;
          const fresh = u.input_tokens ?? 0;
          res.contexts.push(fresh + cacheRead + cacheCreate);
          res.cacheRead += cacheRead;
          res.cacheCreate += cacheCreate;
          res.fresh += fresh;
          res.output += u.output_tokens ?? 0;
        }
        // I risultati dei tool tornano dentro eventi `user`, ed è l'unico punto
        // in cui si vede se in contesto è finita la pagina o il suo puntatore.
        if (ev.type === "user" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content as Record<string, any>[]) {
            if (b?.type !== "tool_result") continue;
            const corpo = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
            if (ON_DISK.test(corpo)) res.suDisco++;
          }
        }
        if (ev.type === "system" && ev.subtype === "compact_boundary") res.compattato = true;
        if (ev.type === "result") {
          // `usage` sul turno di `/compact` è tutto a zero; `modelUsage` no, ed
          // è la somma del turno (verificato su un turno normale: 4 + 103.475 +
          // 670 = 104.149, gli stessi token contati dai `message_delta`).
          const mu = ev.modelUsage as Record<string, Record<string, number>> | undefined;
          if (mu) {
            for (const m of Object.values(mu)) {
              daResult.fresh += m.inputTokens ?? 0;
              daResult.read += m.cacheReadInputTokens ?? 0;
              daResult.create += m.cacheCreationInputTokens ?? 0;
              daResult.out += m.outputTokens ?? 0;
            }
            daResult.visto = true;
          }
          res.text = typeof ev.result === "string" ? ev.result : "";
          if (ev.is_error === true || /^API Error/i.test(res.text)) apiError = res.text.slice(0, 200);
          clearTimeout(bail);
          child.kill();
          resolve();
          return;
        }
      }
    });
    child.on("exit", () => { clearTimeout(bail); resolve(); });
  });

  // IL TURNO DI `/compact` NON PASSA DAI `message_delta`: la richiesta che
  // riassume la sessione la fa la CLI per conto suo e non la mette sullo
  // stream. Contarlo come «non è successo niente» costava caro due volte: il
  // banco chiamava fallimento una compattazione RIUSCITA, e il ritento
  // ricompattava una sessione già compattata (tre `compact_boundary` in fila
  // il 12/08). Il conto del turno c'è, sta in `modelUsage` del `result`.
  if (!res.contexts.length && res.compattato && daResult.visto && !apiError) {
    res.fresh = daResult.fresh;
    res.cacheRead = daResult.read;
    res.cacheCreate = daResult.create;
    res.output = daResult.out;
    res.contexts.push(daResult.fresh + daResult.read + daResult.create);
  }

  // UN TURNO SENZA RICHIESTE NON È UN TURNO A ZERO: è un turno che non è
  // successo. Il 12/08 il provider rispondeva 529 Overloaded, la CLI ritentava
  // e poi mollava — e il banco tirava dritto sommando zeri, cioè preparava un
  // confronto fra un braccio vero e un braccio vuoto. Meglio fermarsi qui: una
  // misura che manca si rifà, una misura sbagliata si crede.
  if (!res.contexts.length || apiError) {
    const perche = apiError || stderr.trim().slice(-400) || "nessuna richiesta arrivata al modello";
    // La frase è il segnale che il turno si può RIFARE: niente è arrivato al
    // modello, quindi lo stato della sessione non si è mosso.
    const pulito = !res.contexts.length ? " — non è successo niente" : "";
    throw new Error(`turno fallito: ${perche}${pulito}`);
  }

  // UN RISULTATO SU DISCO NON È UN RISULTATO PIÙ PICCOLO: è un altro banco.
  // Il contesto cresce di ~1k a fetch invece di ~8k, la soglia non viene mai
  // raggiunta, i due bracci finiscono identici e il confronto sembra dire
  // «compattare non cambia niente» mentre non ha mai compattato. Si alza qui,
  // e senza ritento: il rimedio è una flag, non un altro tentativo.
  if (res.suDisco > 0) {
    throw new Error(
      `turno fallito: la CLI ha versato ${res.suDisco} risultati su disco, in contesto c'è ` +
        `il puntatore e non la pagina. Il tetto MCP è troppo basso: rilancia con --cap 25000.`,
    );
  }
  return res;
}

async function main() {
  mkdirSync(BENCH_DIR, { recursive: true });
  writeFileSync(LOG, "");
  const home = prepareHome();
  const cfg = mcpConfig();
  const sessionId = crypto.randomUUID();
  const seq = urls();

  // Il giro a vuoto: la CLI si ricorda i tool a fine turno, e un processo che
  // parte con il registro freddo paga ~5.400 token di prefisso in più su OGNI
  // richiesta. Senza, i bracci non sarebbero confrontabili — è il difetto che
  // aveva reso storto il banco del tetto.
  await turnConRitenti("Rispondi con una sola parola: ok", crypto.randomUUID(), true, home, cfg);

  const all: { fase: string; ctx: number; tok: number; cost: number }[] = [];
  let tokens = 0;
  let costUsd = 0;
  let compattazioni = 0;
  let ctx = 0;
  let primoTurno = true;

  const conta = (fase: string, r: TurnResult) => {
    const tok = r.contexts.reduce((s, x) => s + x, 0);
    const cost = calculateCostWithCache({
      model: MODEL,
      freshInputTokens: r.fresh,
      outputTokens: r.output,
      cacheReadTokens: r.cacheRead,
      cacheCreationTokens: r.cacheCreate,
    });
    tokens += tok;
    costUsd += cost;
    ctx = r.contexts.length ? r.contexts[r.contexts.length - 1]! : ctx;
    all.push({ fase, ctx, tok, cost });
    console.log(`   ${fase.padEnd(22)} ${String(r.contexts.length).padStart(3)} richieste · contesto ${Math.round(ctx / 1000)}k · ${tok.toLocaleString("it-IT")} token · $${cost.toFixed(3)}`);
  };

  console.log(`\n══ braccio ${ARM} — ${FETCH} fetch in turni da ${PER_TURN}, modello ${MODEL}\n`);

  for (let i = 0; i < seq.length; i += PER_TURN) {
    const blocco = seq.slice(i, i + PER_TURN);
    const prompt = [
      "Chiama il tool `mcp__bench__web_fetch` su questi URL, UNO ALLA VOLTA, in",
      "quest'ordine, aspettando il risultato di ognuno prima del successivo",
      "(non chiamarne due nella stessa mossa):",
      ...blocco.map((u, j) => `   ${i + j + 1}. ${u}`),
      "",
      "Quando li hai fatti tutti rispondi con una sola parola: fatto.",
    ].join("\n");
    const r = await turnConRitenti(prompt, sessionId, primoTurno, home, cfg);
    primoTurno = false;
    conta(`fetch ${i + 1}-${i + blocco.length}`, r);

    if (SOGLIA != null && ctx >= SOGLIA) {
      const c = await turnConRitenti("/compact", sessionId, false, home, cfg);
      // Il braccio con la soglia vale solo se ha COMPATTATO: un `/compact` che
      // non lascia il suo `compact_boundary` ha speso un turno per niente, e il
      // confronto finale racconterebbe due bracci uguali chiamandoli diversi.
      if (!c.compattato) throw new Error("/compact non ha compattato: nessun compact_boundary nel turno");
      compattazioni++;
      conta(`/compact #${compattazioni}`, c);
    }
  }

  // La domanda finale: due marcatori che stanno in pagine scaricate all'inizio.
  // È qui che una compattazione troppo avida si fa vedere.
  const finale = await turnConRitenti(
    [
      "Rispondi con DUE righe, e nient'altro, riportando i marcatori esatti che",
      "compaiono in fondo a queste due pagine, fra quelle che hai scaricato in",
      "questa sessione:",
      `   ${PAGES[ASK[0]! - 1]}: <marcatore>`,
      `   ${PAGES[ASK[1]! - 1]}: <marcatore>`,
      "",
      "Se il contenuto non è più nel contesto, vai a rileggerlo: la risposta deve",
      "essere esatta.",
    ].join("\n"),
    sessionId,
    false,
    home,
    cfg,
  );
  conta("domanda finale", finale);

  const attesi = ASK.map((n) => markerFor(n));
  const markersCorrect = attesi.every((m) => finale.text.includes(m.split(": ")[1]!));

  const out = {
    arm: ARM,
    soglia: SOGLIA,
    model: MODEL,
    fetch: FETCH,
    perTurno: PER_TURN,
    cap: CAP,
    tokens,
    costUsd,
    compattazioni,
    contestoFinale: ctx,
    markersCorrect,
    answer: finale.text.slice(0, 400),
    fasi: all,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `\n   TOTALE ${tokens.toLocaleString("it-IT")} token · $${costUsd.toFixed(2)} · ` +
      `${compattazioni} compattazioni · marcatori ${markersCorrect ? "OK" : "SBAGLIATI"}\n   → ${OUT}`,
  );

  // Il confronto, appena esistono entrambi i bracci.
  const ctrl = join(BENCH_DIR, "compact-senza.json");
  if (SOGLIA != null && existsSync(ctrl)) {
    const base = JSON.parse(readFileSync(ctrl, "utf8"));
    const dTok = (tokens - base.tokens) / base.tokens;
    const dCost = (costUsd - base.costUsd) / base.costUsd;
    console.log(
      `\n   CONTRO IL BRACCIO SENZA SOGLIA: token ${(dTok * 100).toFixed(1)}%, costo ${(dCost * 100).toFixed(1)}%` +
        `  (negativo = risparmio)`,
    );
  }
  if (!markersCorrect) {
    console.error("\n✗ i marcatori non tornano: la compattazione ha tolto la risposta.");
    process.exit(1);
  }
}

if (import.meta.main) await main();
