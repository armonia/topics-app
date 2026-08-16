#!/usr/bin/env bun
/**
 * QUANTO CI METTE UN TURNO, con la CLI e senza.
 *
 * PERCHÉ QUESTO BENCH NON C'ERA, ed è la premessa che rende leggibile il
 * numero. `ai-latency.ts` misura l'overhead che Topics aggiunge sulla strada
 * verso una CLI, con un modello sintetico e a costo zero: risponde a «quanto
 * pesa il nostro tubo», non a «quanto aspetto io». `memory.ts` misura la RAM.
 * Il tempo di un turno VERO — quello che una persona percepisce — non lo
 * misurava nessuno, perché finché Topics guidava solo CLI quel tempo era di
 * qualcun altro.
 *
 * Ora una parte è nostra: il runtime nativo (`providers/native/`) parla
 * direttamente col modello. Quindi la domanda «i task sono più veloci?» ha
 * finalmente una risposta misurabile, ed è questo file.
 *
 * COSA SI CONFRONTA. Lo STESSO lavoro, sullo stesso modello, su due strade:
 *
 *   cli      il provider `claude-code`: spawna la CLI, parla su stdio
 *   native   il runtime di casa: chiama l'API e gira il tool loop in proprio
 *
 * DUE TEMPI, e vanno tenuti separati perché rispondono a due domande diverse.
 *
 *   avvio    dal momento in cui si chiede il turno al PRIMO token leggibile.
 *            È dove la CLI paga lo spawn di un processo Node e il suo boot,
 *            mentre il nativo paga solo la latenza di rete. È anche il tempo
 *            che una persona sente come «reattività».
 *   totale   fino alla fine del turno. Qui domina il MODELLO, che è lo stesso
 *            per entrambi: differenze grandi qui sarebbero sospette, non
 *            vittorie.
 *
 * L'ONESTÀ DEL CONFRONTO, scritta prima dei numeri. La CLI paga lo spawn UNA
 * VOLTA per sessione e poi la tiene calda: un bench che misura solo il primo
 * turno le dà torto in modo sleale. Quindi si misurano N turni di fila sulla
 * STESSA sessione e si riportano il primo e la mediana dei successivi
 * separatamente — il primo turno è la verità per un agente dispacciato (che
 * nasce, lavora e muore), la mediana è la verità per una chat che continua.
 *
 * COSTA SOLDI VERI. Chiama il modello, su entrambe le strade. È il motivo per
 * cui non gira dentro `bun run bench` e va invocato a mano.
 *
 * USAGE
 *   bun run scripts/bench/turn-time.ts                    haiku, 3 turni per strada
 *   bun run scripts/bench/turn-time.ts --turns 5
 *   bun run scripts/bench/turn-time.ts --only native
 *   bun run scripts/bench/turn-time.ts --model claude-sonnet-4-6
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const flag = (name: string, def?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const TURNS = Number(flag("turns", "3"));
const MODEL = flag("model", "claude-haiku-4-5-20251001")!;
const ONLY = flag("only");
/** Il prompt: banale di proposito. Si misura la STRADA, non il ragionamento. */
const PROMPT = "Rispondi con la sola parola PONG.";

interface Sample { startMs: number; totalMs: number; ok: boolean; note?: string }

function stats(xs: number[]) {
  if (xs.length === 0) return { median: NaN, min: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)]!,
    min: s[0]!,
    max: s[s.length - 1]!,
  };
}

/** Il runtime nativo, chiamato come lo chiama il provider. */
async function measureNative(): Promise<Sample[]> {
  const { runAgentTurn } = await import("../../server/providers/native/agent-loop");
  const ws = mkdtempSync(join(tmpdir(), "bench-turn-"));
  const out: Sample[] = [];
  // UNA sessione per tutti i turni: è il confronto giusto con una CLI calda.
  const history: any[] = [];
  try {
    for (let i = 0; i < TURNS; i++) {
      history.push({ role: "user", content: PROMPT });
      const t0 = performance.now();
      let first = 0;
      const r = await runAgentTurn(
        { model: MODEL, history, tools: [], toolContext: { workspace: ws } },
        {
          onTextDelta: () => { if (!first) first = performance.now(); },
          onToolStart: () => {},
          onToolResult: () => {},
          onDone: () => {},
          onError: () => {},
        },
      );
      const t1 = performance.now();
      out.push({
        startMs: first ? first - t0 : NaN,
        totalMs: t1 - t0,
        ok: r.turnEnd.end === "end_turn",
      });
    }
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* scratch */ }
  }
  return out;
}

/**
 * La CLI, misurata come la usa Topics: il provider `claude-code` sulla stessa
 * sessione, non un `claude --print` a mano — quello misurerebbe un programma
 * che Topics non esegue.
 */
async function measureCli(): Promise<Sample[]> {
  const { initDatabase, closeDatabase } = await import("../../server/db");
  const root = mkdtempSync(join(tmpdir(), "bench-cli-"));
  mkdirSync(join(root, "server", "db", "migrations"), { recursive: true });
  // Le migration vere: il provider legge il DB per gli override per-topic.
  const { readdirSync, readFileSync } = await import("fs");
  const real = join(import.meta.dir, "..", "..", "server", "db", "migrations");
  for (const f of readdirSync(real)) {
    if (f.endsWith(".sql")) writeFileSync(join(root, "server", "db", "migrations", f), readFileSync(join(real, f), "utf-8"));
  }
  const savedData = process.env.DATA_DIR;
  process.env.DATA_DIR = join(root, "data");

  const out: Sample[] = [];
  try {
    initDatabase(root);
    // Una topic VERA: il provider registra la sessione con una foreign key
    // sulla riga, e senza il turno muore su un errore di schema invece che
    // misurare qualcosa. È lo stato in cui una sessione esiste davvero.
    const { getDatabase } = await import("../../server/db");
    const now = new Date().toISOString();
    getDatabase()
      .prepare("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("bench-topic", "bench", "bench", "bench:turn", now, now);
    const { ClaudeCodeProvider } = await import("../../server/providers/claude-code");
    const p = new ClaudeCodeProvider({ type: "claude-code", model: MODEL } as any);
    p.start();
    const key = "bench:turn";
    try {
      for (let i = 0; i < TURNS; i++) {
        const t0 = performance.now();
        let first = 0;
        let errored: string | undefined;
        await new Promise<void>((resolve) => {
          void p.sendChat(key, PROMPT, {
            onTextDelta: () => { if (!first) first = performance.now(); },
            onToolStart: () => {},
            onToolResult: () => {},
            onDone: () => resolve(),
            onError: (e: string) => { errored = e; resolve(); },
          } as any, { model: MODEL }).catch((e: unknown) => { errored = String(e); resolve(); });
        });
        const t1 = performance.now();
        out.push({
          startMs: first ? first - t0 : NaN,
          totalMs: t1 - t0,
          ok: !errored,
          note: errored?.slice(0, 80),
        });
      }
    } finally {
      try { p.stop(); } catch { /* già fermo */ }
    }
  } finally {
    try { closeDatabase(); } catch { /* già chiusa */ }
    if (savedData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedData;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* scratch */ }
  }
  return out;
}

function report(label: string, xs: Sample[]) {
  const ok = xs.filter((s) => s.ok);
  if (ok.length === 0) {
    console.log(`${label.padEnd(8)} nessun turno riuscito${xs[0]?.note ? ` — ${xs[0].note}` : ""}`);
    return null;
  }
  const firstTurn = ok[0]!;
  const rest = ok.slice(1);
  const s = stats(rest.map((x) => x.startMs).filter(Number.isFinite));
  const t = stats(rest.map((x) => x.totalMs));
  console.log(
    `${label.padEnd(8)} 1° turno: avvio ${firstTurn.startMs.toFixed(0).padStart(5)} ms  totale ${firstTurn.totalMs.toFixed(0).padStart(5)} ms` +
    (rest.length ? `   |  poi (mediana di ${rest.length}): avvio ${s.median.toFixed(0).padStart(5)} ms  totale ${t.median.toFixed(0).padStart(5)} ms` : ""),
  );
  return { label, firstStartMs: firstTurn.startMs, firstTotalMs: firstTurn.totalMs, medianStartMs: s.median, medianTotalMs: t.median, n: ok.length };
}

const rows: unknown[] = [];
console.log(`\nmodello ${MODEL}, ${TURNS} turni per strada, prompt «${PROMPT}»\n`);

if (ONLY !== "cli") {
  const r = report("native", await measureNative());
  if (r) rows.push(r);
}
if (ONLY !== "native") {
  const r = report("cli", await measureCli());
  if (r) rows.push(r);
}

const outPath = join(import.meta.dir, "..", "..", "bench", "results", "turn-time-latest.json");
writeFileSync(outPath, JSON.stringify({
  schema: "bench-turn-time-v1",
  measured_at: new Date().toISOString(),
  model: MODEL,
  turns: TURNS,
  prompt: PROMPT,
  caveats: [
    "Chiama il modello VERO su entrambe le strade: questo run è costato soldi.",
    "Il tempo TOTALE è dominato dal modello, che è lo stesso per entrambe: differenze grandi lì sono sospette, non vittorie.",
    "Il 1° turno è la verità per un agente dispacciato (nasce, lavora, muore); la mediana dei successivi è la verità per una chat che continua.",
    "La CLI tiene la sessione calda dopo il primo turno: confrontare solo il primo le darebbe torto in modo sleale.",
  ],
  rows,
}, null, 2));
console.log(`\nscritto ${outPath}\n`);
