/**
 * LA CURVA VERA: come cresce il contesto in una sessione REALE, richiesta per
 * richiesta — e quanta parte di quella crescita la compattazione potrebbe mordere.
 *
 * ── Perché serviva ──────────────────────────────────────────────────────────
 * La decomposizione del banco (`decompose.ts`) dice che il prefisso è l'88% dei
 * token di prompt e la conversazione riletta il 2,6%. Vero, e misurato: ma nel
 * REGIME DEL BANCO, cioè 13 richieste con il contesto che va da 32k a 42k. Il
 * prefisso pesa 32k a ogni richiesta; se il contesto non supera i 42k, il
 * prefisso È quasi tutto il contesto, e la compattazione non ha niente da
 * mordere perché non c'è ancora niente da compattare.
 *
 * La card parlava di un'altra cosa: una sessione a 320k su 104 chiamate. Lì lo
 * stesso prefisso da 32k è il 10% del contesto, non l'88%. Sono due regimi, e la
 * quota del prefisso è l'unica grandezza che li distingue — quindi va MISURATA
 * dove la domanda vive, non estrapolata da dove non vive.
 *
 * ── Cosa legge ──────────────────────────────────────────────────────────────
 * I transcript della CLI (`~/.claude/projects/<progetto>/<sessione>.jsonl`). Ogni
 * messaggio `assistant` porta l'`usage` della richiesta che l'ha prodotto, e il
 * contesto di quella richiesta è `input + cache_read + cache_creation` — gli
 * stessi tre addendi che paga `decompose.ts`, così i due script parlano della
 * stessa grandezza.
 *
 * ── Le tre trappole, tutte già costate un numero sbagliato ──────────────────
 *  • UN messaggio assistant con tre blocchi produce TRE righe con lo stesso
 *    `usage`: contare le righe triplica la sessione. La chiave è `requestId`.
 *  • I sotto-agenti (`isSidechain: true`) hanno un contesto TUTTO LORO, con un
 *    prefisso proprio: sommarli alla sessione madre significa mescolare due
 *    finestre. Qui si separano, e si contano a parte.
 *  • Un contesto che SCENDE fra due richieste non è rumore: o la CLI ha
 *    compattato, o il transcript è un fork. In entrambi i casi la curva riparte,
 *    e chi somma alla cieca legge una crescita che non c'è stata.
 *
 *     bun scripts/mcp-cap-bench/real-context-curve.ts [--top 12] [--min-req 20]
 *                                                     [--json] [--out <file>]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const TOP = Number(flag("--top", "12"));
/** Sotto questo numero di richieste una sessione non dice niente sul regime lungo. */
const MIN_REQ = Number(flag("--min-req", "20"));
const AS_JSON = argv.includes("--json");
const OUT = flag("--out");
const ROOT = flag("--root", join(homedir(), ".claude", "projects"))!;

/** Una richiesta, coi tre addendi separati: il prezzo non li paga allo stesso modo. */
export interface RequestUsage {
  /** `input + cache_read + cache_creation` — il contesto che quella richiesta ha spedito. */
  context: number;
  /** Token letti dalla cache: costano un decimo. */
  cacheRead: number;
  /** Token scritti in cache: costano 1,25 volte (o 2 con la cache da un'ora). */
  cacheCreate: number;
  /** Token di prompt nudi, fuori cache. */
  input: number;
  output: number;
}

export interface SessionCurve {
  project: string;
  session: string;
  /** Contesto di ogni richiesta, in ordine: `input + cache_read + cache_creation`. */
  contexts: number[];
  /** Gli stessi contesti, spacchettati per voce di prezzo. */
  usage: RequestUsage[];
  /** Il modello che ha servito la sessione (l'ultimo nominato), per il listino. */
  model: string | null;
  /**
   * Indici (0-based, dentro `contexts`) delle richieste che arrivano SUBITO DOPO
   * una compattazione dichiarata dalla CLI (`isCompactSummary`). È la misura di
   * quanto resta dopo un taglio vero: senza, la taglia del riassunto sarebbe un
   * numero scelto a occhio, che è esattamente il difetto che questa card
   * rimprovera alla soglia.
   */
  afterCompaction: number[];
  /** La somma dei contesti: i token di prompt che la sessione ha davvero pagato. */
  total: number;
  /** Il contesto più grande raggiunto. */
  peak: number;
  /**
   * Il prefisso, stimato al ribasso: il contesto più PICCOLO che la sessione ha
   * mai spedito. È un limite superiore alla parte incomprimibile — dentro c'è
   * anche il primo prompt utente — ed è l'unica stima che un transcript concede
   * senza una sonda a parte (`prefix-probe.ts` la misura per davvero).
   */
  prefixFloor: number;
  /** Quante volte il contesto è SCESO: compattazioni della CLI, o fork. */
  drops: number;
  /** Richieste dei sotto-agenti, che hanno una finestra tutta loro. */
  sidechainRequests: number;
  /** Token di prompt spesi dai sotto-agenti (contesto separato, costo vero). */
  sidechainTotal: number;
}

/** Il contesto di una richiesta: i tre addendi che si pagano. */
function contextOf(u: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

export function readCurve(path: string, project: string, session: string): SessionCurve | null {
  const main: RequestUsage[] = [];
  let sidechainRequests = 0;
  let sidechainTotal = 0;
  /**
   * Chi ha servito la sessione, per NUMERO di richieste — non «l'ultimo
   * nominato». La CLI marca i suoi messaggi finti con il modello `<synthetic>`
   * (errori, avvisi): se capita in fondo, l'ultimo-nominato manda l'intera
   * sessione su un modello che non è in listino, e il conto esce zero.
   */
  const modelCounts = new Map<string, number>();
  const afterCompaction: number[] = [];
  /** Alzata dal riassunto di compattazione, ricade sulla prima richiesta che segue. */
  let compactionPending = false;
  /** Una richiesta = un `requestId`. Senza, i blocchi la contano più volte. */
  const seen = new Set<string>();

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Il riassunto di compattazione arriva come messaggio UTENTE marcato: la
    // richiesta che lo segue è la prima della finestra nuova.
    if (ev.isCompactSummary === true) {
      compactionPending = true;
      continue;
    }
    if (ev.type !== "assistant") continue;
    const msg = (ev.message ?? {}) as Record<string, unknown>;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") {
      modelCounts.set(msg.model, (modelCounts.get(msg.model) ?? 0) + 1);
    }
    // Senza `requestId` non si può deduplicare: si cade sull'uuid del messaggio,
    // che è per BLOCCO e quindi sovrastima. Meglio saltarla che gonfiare.
    const key = typeof ev.requestId === "string" ? ev.requestId : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ctx = contextOf(usage);
    if (ctx <= 0) continue;
    if (ev.isSidechain === true) {
      sidechainRequests++;
      sidechainTotal += ctx;
    } else {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      if (compactionPending) {
        afterCompaction.push(main.length);
        compactionPending = false;
      }
      main.push({
        context: ctx,
        cacheRead: n(usage.cache_read_input_tokens),
        cacheCreate: n(usage.cache_creation_input_tokens),
        input: n(usage.input_tokens),
        output: n(usage.output_tokens),
      });
    }
  }
  if (!main.length) return null;

  const contexts = main.map((r) => r.context);
  const model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  let drops = 0;
  for (let i = 1; i < contexts.length; i++) if (contexts[i]! < contexts[i - 1]!) drops++;

  return {
    project,
    session,
    contexts,
    usage: main,
    model,
    afterCompaction,
    total: contexts.reduce((s, x) => s + x, 0),
    peak: Math.max(...contexts),
    prefixFloor: Math.min(...contexts),
    drops,
    sidechainRequests,
    sidechainTotal,
  };
}

/** Tutte le sessioni sotto `root`, dalla più costosa in giù. */
export function scanSessions(root: string, minRequests: number): SessionCurve[] {
  const out: SessionCurve[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const c = readCurve(join(dir, f), project, f.replace(/\.jsonl$/, ""));
      if (c && c.contexts.length >= minRequests) out.push(c);
    }
  }
  return out.sort((a, b) => b.total - a.total);
}

if (import.meta.main) {
  const sessions = scanSessions(ROOT, MIN_REQ);
  if (!sessions.length) {
    console.error(`nessuna sessione con almeno ${MIN_REQ} richieste sotto ${ROOT}`);
    process.exit(1);
  }

  if (OUT) {
    // Il file serve al simulatore, che lavora sul regime lungo: scriverci anche
    // le sessioni da 40k gonfia il file e non sposta una virgola del verdetto.
    const peak = Number(flag("--out-min-peak", "150000"));
    writeFileSync(OUT, JSON.stringify(sessions.filter((s) => s.peak >= peak), null, 2) + "\n");
  }
  if (AS_JSON) {
    console.log(JSON.stringify(sessions.slice(0, TOP), null, 2));
  } else {
    const it = (n: number) => Math.round(n).toLocaleString("it-IT");
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    console.log(`\n${sessions.length} sessioni con almeno ${MIN_REQ} richieste — le ${TOP} più costose:\n`);
    console.log("   richieste   picco   prefisso  quota pref.   token di prompt   cali   sessione");
    for (const s of sessions.slice(0, TOP)) {
      const prefixShare = (s.prefixFloor * s.contexts.length) / s.total;
      console.log(
        `   ${String(s.contexts.length).padStart(9)}  ${k(s.peak).padStart(6)}  ${k(s.prefixFloor).padStart(9)}` +
          `  ${(prefixShare * 100).toFixed(1).padStart(10)}%  ${it(s.total).padStart(16)}  ${String(s.drops).padStart(5)}` +
          `   ${s.session.slice(0, 8)} ${s.project.slice(-28)}`,
      );
    }
    // Le compattazioni VERE: a che contesto sono scattate e quanto hanno
    // lasciato. È il numero che il simulatore non deve inventarsi.
    const tagli: { pre: number; post: number; prefix: number }[] = [];
    for (const s of sessions) {
      for (const i of s.afterCompaction) {
        if (i === 0) continue;
        tagli.push({ pre: s.contexts[i - 1]!, post: s.contexts[i]!, prefix: s.prefixFloor });
      }
    }
    if (tagli.length) {
      const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const riassunti = tagli.map((t) => Math.max(0, t.post - t.prefix));
      console.log(
        `\n   ${tagli.length} compattazioni DICHIARATE dalla CLI: scattano a ${k(med(tagli.map((t) => t.pre)))}` +
          ` di contesto (mediana) e lasciano ${k(med(tagli.map((t) => t.post)))}.` +
          `\n   Il riassunto da solo (post − prefisso) è ${k(med(riassunti))} in mediana, ` +
          `da ${k(Math.min(...riassunti))} a ${k(Math.max(...riassunti))}.`,
      );
    }

    // La riga che risponde alla domanda del regime: dove sta il prefisso quando
    // la sessione è LUNGA, non quando è quella del banco.
    const long = sessions.filter((s) => s.peak >= 150_000);
    if (long.length) {
      const share =
        long.reduce((s, x) => s + (x.prefixFloor * x.contexts.length) / x.total, 0) / long.length;
      console.log(
        `\n   ${long.length} sessioni con picco ≥150k: il prefisso è in media il ${(share * 100).toFixed(1)}%` +
          ` dei token di prompt.\n   Il resto (${(100 - share * 100).toFixed(1)}%) è materiale che una compattazione può togliere.`,
      );
    }
    if (OUT) console.log(`\n   serie complete → ${OUT}`);
  }
}
