/**
 * IL CONTROFATTUALE: cosa avrebbe pagato una sessione VERA se avesse compattato
 * a una soglia T, invece di aspettare che la finestra si riempisse.
 *
 * ── Perché un controfattuale e non solo un banco ────────────────────────────
 * Il banco vivo (`bench.ts --lever compact`) misura DUE sessioni. Questo ne
 * misura 351, quelle già girate, e lo fa sulla loro aritmetica esatta: il
 * contesto di ogni richiesta è un numero letto dal transcript, non una stima.
 * I due si controllano a vicenda — questo dice DOVE mettere la soglia, il banco
 * dice se il numero regge quando a rispondere è il modello vero.
 *
 * ── Il modello, e i suoi tre parametri, tutti e tre MISURATI ────────────────
 *  • la crescita del contesto, richiesta per richiesta: presa pari pari dalla
 *    sessione vera (`d(k) = C(k) − C(k−1)`), perché i risultati dei tool
 *    arrivano uguali che si compatti o no;
 *  • il PREFISSO: il contesto più piccolo che la sessione abbia mai spedito —
 *    è la parte che nessuna compattazione può togliere;
 *  • la taglia del RIASSUNTO: mediana delle 544 compattazioni dichiarate dalla
 *    CLI nei transcript (`real-context-curve.ts`), ~15k. Non un numero scelto a
 *    occhio: è il difetto che questa card rimprovera alla soglia esistente, e
 *    sarebbe ridicolo ripeterlo qui.
 *
 * ── Il prezzo, che non è i token ────────────────────────────────────────────
 * Compattare BRUCIA la cache: il riassunto è testo nuovo, e la richiesta dopo
 * lo paga a 1,25×, mentre i token che ha tolto costavano 0,1× perché venivano
 * dalla cache. Un conto fatto solo in token quindi ESAGERA il risparmio, e di
 * parecchio. Qui si contano tutte e due le grandezze.
 *
 * ── Il cancello: il modello deve saper rifare il conto VERO ─────────────────
 * Prima di rispondere a «e se avesse compattato», il simulatore rifà il conto
 * della sessione COSÌ COM'È — stessa curva, nessuna compattazione aggiunta — e
 * confronta la sua ripartizione fra cache_read e cache_creation con quella che
 * il provider ha davvero fatturato. Se sbaglia il conto che può verificare, non
 * ha nessun titolo per fare quello che non può: esce NON-ZERO.
 *
 * ── Quello che questo script NON sa ─────────────────────────────────────────
 * Compattare toglie dettaglio, e un agente che ha perso il dettaglio rilegge i
 * file: chiamate in più, che qui non compaiono. Il risparmio calcolato è quindi
 * un LIMITE SUPERIORE, e serve il banco vivo per sapere quanto se ne mangia il
 * lavoro ripetuto.
 *
 *     bun scripts/mcp-cap-bench/compact-sim.ts [--curves <file>] [--summary 15000]
 *                                              [--min-peak 150000] [--json]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { calculateCostWithCache } from "../../server/usage/pricing";
import type { SessionCurve } from "./real-context-curve";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const BENCH_DIR = process.env.TOPICS_BENCH_DIR || join(homedir(), ".topics", "media", "mcp-cap-bench");
const CURVES = flag("--curves", join(BENCH_DIR, "real-curves.json"))!;
/** Mediana misurata sulle compattazioni dichiarate dalla CLI. */
const SUMMARY = Number(flag("--summary", "15000"));
/** Sotto questo picco la sessione non è nel regime di cui parla la card. */
const MIN_PEAK = Number(flag("--min-peak", "150000"));
const AS_JSON = argv.includes("--json");
/** Il modello di listino quando il transcript non lo dice. */
const FALLBACK_MODEL = flag("--model", "claude-opus-5")!;

/** Le soglie da provare, dalla più aggressiva alla più larga. */
const THRESHOLDS = [80_000, 100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 700_000];

export interface Bill {
  tokens: number;
  costUsd: number;
  requests: number;
  compactions: number;
}

/**
 * Il conto di una sequenza di contesti, con la cache modellata come la fa il
 * provider: quello che c'era già nella richiesta precedente si RILEGGE (0,1×),
 * quello che è stato appeso dopo si SCRIVE (1,25×). Un contesto che scende
 * sotto il precedente (una compattazione) rilegge solo quello che sopravvive.
 */
export function bill(contexts: number[], model: string, outputs: number[]): Bill {
  let tokens = 0;
  let costUsd = 0;
  let cachedAtEnd = 0;
  contexts.forEach((ctx, i) => {
    const cacheRead = Math.min(cachedAtEnd, ctx);
    const cacheCreate = Math.max(0, ctx - cacheRead);
    tokens += ctx;
    costUsd += calculateCostWithCache({
      model,
      freshInputTokens: 0,
      outputTokens: outputs[i] ?? 0,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
    });
    cachedAtEnd = ctx;
  });
  return { tokens, costUsd, requests: contexts.length, compactions: 0 };
}

/**
 * La sessione rigirata con una soglia di compattazione a `threshold`.
 *
 * Le crescite sono quelle vere. Quando il contesto le supera, si paga UNA
 * richiesta in più — la compattazione rilegge tutto il contesto per riassumerlo,
 * e non è gratis — e si riparte da `prefisso + riassunto`.
 */
export function simulate(
  curve: Pick<SessionCurve, "contexts" | "prefixFloor" | "usage">,
  threshold: number,
  summaryTokens: number,
  model: string,
): Bill {
  const P = curve.prefixFloor;
  const contexts: number[] = [];
  const outputs: number[] = [];
  let compactions = 0;
  let ctx = 0;

  curve.contexts.forEach((real, i) => {
    const out = curve.usage[i]?.output ?? 0;
    if (i === 0) {
      ctx = real;
    } else {
      const grown = real - curve.contexts[i - 1]!;
      // Una crescita negativa è una compattazione (o un fork) già avvenuta:
      // si adotta il contesto vero, il controfattuale non la ripete.
      ctx = grown < 0 ? real : ctx + grown;
    }
    if (ctx >= threshold && ctx > P + summaryTokens) {
      // La chiamata che riassume: legge tutto quello che c'è, e produce il
      // riassunto. È il prezzo del taglio, e va nel conto come una richiesta.
      contexts.push(ctx);
      outputs.push(summaryTokens);
      compactions++;
      ctx = P + summaryTokens;
    }
    contexts.push(ctx);
    outputs.push(out);
  });

  const b = bill(contexts, model, outputs);
  return { ...b, compactions };
}

if (import.meta.main) {
  if (!existsSync(CURVES)) {
    console.error(`manca ${CURVES} — gira prima: bun scripts/mcp-cap-bench/real-context-curve.ts --out ${CURVES}`);
    process.exit(1);
  }
  const all = JSON.parse(readFileSync(CURVES, "utf8")) as SessionCurve[];
  const sessions = all.filter((s) => s.peak >= MIN_PEAK && s.usage?.length);
  if (!sessions.length) {
    console.error(`nessuna sessione con picco ≥${MIN_PEAK} in ${CURVES}`);
    process.exit(1);
  }

  // ── Il cancello: il modello di cache deve rifare il conto VERO ─────────────
  let realCost = 0;
  let modelCost = 0;
  for (const s of sessions) {
    const model = s.model || FALLBACK_MODEL;
    for (const u of s.usage) {
      realCost += calculateCostWithCache({
        model,
        freshInputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheCreationTokens: u.cacheCreate,
      });
    }
    modelCost += bill(s.contexts, model, s.usage.map((u) => u.output)).costUsd;
  }
  const scarto = Math.abs(modelCost - realCost) / realCost;

  const rows = THRESHOLDS.map((t) => {
    let tokens = 0;
    let costUsd = 0;
    let compactions = 0;
    for (const s of sessions) {
      const r = simulate(s, t, SUMMARY, s.model || FALLBACK_MODEL);
      tokens += r.tokens;
      costUsd += r.costUsd;
      compactions += r.compactions;
    }
    return { threshold: t, tokens, costUsd, compactions };
  });
  const base = {
    tokens: sessions.reduce((s, x) => s + x.total, 0),
    costUsd: modelCost,
  };

  const out = { sessions: sessions.length, summaryTokens: SUMMARY, base, rows, scartoModello: scarto };
  if (AS_JSON) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const it = (n: number) => Math.round(n).toLocaleString("it-IT");
    console.log(
      `\n${sessions.length} sessioni vere con picco ≥${Math.round(MIN_PEAK / 1000)}k` +
        `  ·  riassunto ${Math.round(SUMMARY / 1000)}k (mediana misurata)\n`,
    );
    console.log(`   COSÌ COM'È:  ${it(base.tokens)} token  ·  $${base.costUsd.toFixed(2)}\n`);
    console.log("   soglia    token totali   risparmio    costo      risparmio $   compattazioni");
    for (const r of rows) {
      const dTok = (r.tokens - base.tokens) / base.tokens;
      const dCost = (r.costUsd - base.costUsd) / base.costUsd;
      console.log(
        `   ${`${Math.round(r.threshold / 1000)}k`.padStart(6)}  ${it(r.tokens).padStart(14)}` +
          `  ${`${(-dTok * 100).toFixed(1)}%`.padStart(9)}  $${r.costUsd.toFixed(2).padStart(8)}` +
          `  ${`${(-dCost * 100).toFixed(1)}%`.padStart(11)}  ${it(r.compactions).padStart(14)}`,
      );
    }
    const best = rows.reduce((a, b) => (b.costUsd < a.costUsd ? b : a));
    console.log(
      `\n   Il minimo in DOLLARI è a ${Math.round(best.threshold / 1000)}k` +
        ` (${(((base.costUsd - best.costUsd) / base.costUsd) * 100).toFixed(1)}% in meno).`,
    );
    console.log(
      `\n   controprova del modello di cache sul conto vero: scarto ${(scarto * 100).toFixed(1)}%` +
        ` ($${modelCost.toFixed(2)} contro $${realCost.toFixed(2)})`,
    );
    const p = join(BENCH_DIR, "compact-sim.json");
    writeFileSync(p, JSON.stringify(out, null, 2) + "\n");
    console.log(`   dettaglio → ${p}`);
  }

  // Un modello che sbaglia il conto verificabile di più del 15% non ha titolo
  // per rispondere a quello che non si può verificare.
  if (scarto > 0.15) {
    console.error(`\n✗ il modello di cache sbaglia il conto vero del ${(scarto * 100).toFixed(1)}%: non è affidabile.`);
    process.exit(1);
  }
}
