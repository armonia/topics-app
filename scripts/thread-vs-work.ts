#!/usr/bin/env bun
/**
 * thread-vs-work — il thread del task si assottiglia, o no?
 *
 * ── La domanda ──────────────────────────────────────────────────────────────
 * Il modello del coordinatore sposta il lavoro fuori dalla sessione del task.
 * La promessa è che il THREAD diventi leggibile e economico, non che il lavoro
 * costi meno: le sessioni figlie spendono quanto spendevano prima, e si
 * contabilizzano sulla stessa card (dispatch-usage.ts). Quindi la misura giusta
 * NON è il costo totale, è quanto pesa la sessione dove si decide.
 *
 * Questo script fa girare LO STESSO lavoro due volte, dallo stesso stato, e
 * confronta i token della sessione-thread:
 *
 *   worker        una sessione sola: legge, prova, scrive, conclude. È il
 *                 modello di prima, dove il thread È il lavoro.
 *   coordinatore  una sessione che DELEGA: lancia una sessione di lavoro, ne
 *                 legge l'esito, decide, conclude. Il suo transcript è il
 *                 thread; quello della figlia è il lavoro.
 *
 * ── Il cancello ─────────────────────────────────────────────────────────────
 * Esce NON-ZERO se il thread del coordinatore non è più sottile di quello del
 * worker. Non è una soglia di gusto: se il thread non si assottiglia il cambio
 * non ha reso, e va detto invece di raccontarlo.
 *
 * Il lavoro totale NON è un cancello, e si stampa apposta: il coordinatore
 * paga un secondo prefisso (la sua figlia riparte da zero contesto), quindi il
 * totale può benissimo salire. È il prezzo dichiarato del cambio, e sapere
 * quanto vale è metà del punto di questa misura.
 *
 * ── Da dove escono i numeri ─────────────────────────────────────────────────
 * Dal reader vero del server (`server/services/transcript-usage.ts`), lo stesso
 * che alimenta `tasks.agent_tokens`: dedup per `message.id`, cache-read tenuti
 * separati dal lavoro. Non c'è una seconda aritmetica.
 *
 * ── STATO: VERDE, con numeri veri ───────────────────────────────────────────
 * Corsa del 13/08/2026, dopo il secondo dei due guasti di percorso (vedi
 * `transcriptDir`):
 *
 *   braccio       thread(work tok)   thread(cacheRead)   lavoro delegato
 *   worker                  59.046             226.573                 0
 *   coordinator             21.020             214.199            20.467
 *
 * Il thread del coordinatore pesa 0,36 di quello del worker: si assottiglia, e
 * non di poco. Da segnare perche' smentisce l'attesa scritta qui sopra: in
 * questa corsa il TOTALE del coordinatore (41.487) e' sceso sotto quello del
 * worker (59.046), invece di salire per il secondo prefisso. E' una corsa sola
 * su un corpus solo, quindi vale come misura, non ancora come legge.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *
 *   bun run measure:thread                 # entrambi i bracci, poi il verdetto
 *   bun run measure:thread --out out.json  # e scrive il bundle
 *   bun run measure:thread --keep          # non cancella le sandbox
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTranscriptUsageReader, type SessionUsage } from "../server/services/transcript-usage";
import { claudeProjectDirName } from "../server/lib/claude-transcript-path";

const MODEL = "claude-opus-5[1m]";
const MAX_TURNS = 40;
const RUN_TIMEOUT_MS = 15 * 60_000;
const ALLOWED_TOOLS = "Read,Grep,Glob,Write,Bash";

/**
 * IL CORPUS. Un pezzo di repo vero, copiato in sandbox: file abbastanza grossi
 * da rendere la lettura un costo, e abbastanza reali da non essere un esercizio
 * di fantasia. Sono gli stessi file per i due bracci, byte per byte.
 */
const CORPUS = [
  "server/services/tasks.ts",
  "server/services/task-dispatcher.ts",
  "server/services/agent-census.ts",
  "server/services/dispatch-usage.ts",
  "server/services/board-ask-routing.ts",
  "server/routes/terminal.ts",
  "server/mcp/topics-mcp-server.ts",
];

/**
 * IL LAVORO, identico nei due bracci. Chiede una risposta VERIFICABILE (un file
 * json con dentro un conteggio) perché un braccio che non consegna non è un
 * braccio economico, è un braccio che non ha lavorato.
 */
const GOAL =
  "Nella cartella corrente ci sono dei file TypeScript. Trova ogni funzione esportata il cui nome inizia per `create` " +
  "(cioe' le righe `export function create...`), e scrivi `report.json` con esattamente questa forma: " +
  '{"total": <numero totale>, "byFile": {"<nome file>": <quante>}} — solo i file che ne hanno almeno una, ordinati per nome. ' +
  "Poi rispondi in UNA riga: quale file ne ha di piu' e quante.";

const repoRoot = resolve(import.meta.dir, "..");

/**
 * IL PERCORSO VA RISOLTO, e questa riga e' costata una corsa intera.
 *
 * `mkdtempSync(tmpdir())` su macOS restituisce `/var/folders/...`, che e' un
 * symlink a `/private/var/folders/...`. `claude` registra il transcript sotto
 * la cwd REALE, quindi la cartella cercata col percorso non risolto non esiste:
 * la lettura torna zero su TUTTI e due i bracci, e il confronto diventa 0 vs 0
 * mentre i due agenti hanno lavorato e consegnato davvero. Uno zero non e' un
 * numero basso, e' l'assenza di misura: il cancello lo dice rosso, ed e' giusto
 * cosi'. (`board-arms.ts` risolve da sempre, per la stessa ragione.)
 *
 * E la stessa cartella aveva un SECONDO modo di non esistere, che ha mangiato
 * la corsa successiva: `claudeProjectDirName()` sostituiva solo `/` e `.`,
 * mentre `claude` sostituisce OGNI carattere non alfanumerico. La temp dir di
 * macOS e' `/var/folders/d8/<venti>_<altri>/T/`, e quell'underscore bastava a
 * mandare la lettura su un percorso vuoto. Risolvere il symlink era necessario
 * e non sufficiente: due guasti diversi, lo stesso identico 0 vs 0. Quando la
 * misura torna zero da entrambe le parti, il sospettato non e' il reader, e' il
 * percorso.
 */
function transcriptDir(cwd: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* la cartella potrebbe non esserci ancora */ }
  return join(process.env.HOME ?? "", ".claude", "projects", claudeProjectDirName(real));
}

function transcriptFiles(cwd: string): string[] {
  const dir = transcriptDir(cwd);
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, billableTokens: 0 };

/** Il consumo dei transcript comparsi in `cwd` durante la corsa. */
function usageOfNewTranscripts(cwd: string, before: ReadonlySet<string>): { usage: SessionUsage; files: string[] } {
  const reader = createTranscriptUsageReader();
  const fresh = transcriptFiles(cwd).filter((f) => !before.has(f));
  let total: SessionUsage = { ...ZERO };
  for (const f of fresh) {
    const u = reader.read(f);
    total = {
      inputTokens: total.inputTokens + u.inputTokens,
      outputTokens: total.outputTokens + u.outputTokens,
      cacheWriteTokens: total.cacheWriteTokens + u.cacheWriteTokens,
      cacheWrite1hTokens: total.cacheWrite1hTokens + u.cacheWrite1hTokens,
      cacheReadTokens: total.cacheReadTokens + u.cacheReadTokens,
      billableTokens: total.billableTokens + u.billableTokens,
    };
  }
  return { usage: total, files: fresh };
}

/** Una sandbox col corpus dentro. Due bracci, due sandbox, stesso contenuto. */
function makeSandbox(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const rel of CORPUS) {
    const flat = rel.replace(/\//g, "__");
    writeFileSync(join(dir, flat), readFileSync(join(repoRoot, rel), "utf-8"));
  }
  return dir;
}

function runClaude(cwd: string, prompt: string, extraTools = ALLOWED_TOOLS) {
  return spawnSync(
    "claude",
    ["-p", "--model", MODEL, "--max-turns", String(MAX_TURNS), "--permission-mode", "acceptEdits", "--allowedTools", extraTools],
    { cwd, input: prompt, encoding: "utf8", timeout: RUN_TIMEOUT_MS, env: { ...process.env } },
  );
}

interface ArmResult {
  arm: "worker" | "coordinator";
  wallClockMs: number;
  exitCode: number | null;
  /** Il transcript della sessione DOVE SI DECIDE: e' questo il thread. */
  thread: SessionUsage;
  /** I transcript delle sessioni di lavoro. Zero per il braccio `worker`. */
  work: SessionUsage;
  delivered: boolean;
  reportTotal: number | null;
  dir: string;
}

function readReport(dir: string): number | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, "report.json"), "utf-8"));
    return typeof j?.total === "number" ? j.total : null;
  } catch {
    return null;
  }
}

function runWorker(root: string): ArmResult {
  const dir = makeSandbox(root, "worker");
  const before = new Set(transcriptFiles(dir));
  const t0 = Date.now();
  const r = runClaude(dir, GOAL);
  const wallClockMs = Date.now() - t0;
  const { usage } = usageOfNewTranscripts(dir, before);
  const total = readReport(dir);
  return { arm: "worker", wallClockMs, exitCode: r.status, thread: usage, work: { ...ZERO }, delivered: total !== null, reportTotal: total, dir };
}

function runCoordinator(root: string): ArmResult {
  const dir = makeSandbox(root, "coordinator");
  // La figlia lavora in una SUA cartella, e non è un dettaglio: i transcript si
  // indicizzano per cwd, quindi due cwd diverse sono l'unico modo di separare il
  // thread dal lavoro senza indovinare quale file appartiene a chi.
  const kid = join(dir, "sessione-di-lavoro");
  mkdirSync(kid, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f === "sessione-di-lavoro") continue;
    writeFileSync(join(kid, f), readFileSync(join(dir, f), "utf-8"));
  }
  const beforeThread = new Set(transcriptFiles(dir));
  const beforeKid = new Set(transcriptFiles(kid));

  const prompt =
    "Sei il COORDINATORE di questo compito. Questa sessione e' dove si DECIDE, non dove si lavora.\n\n" +
    `OBIETTIVO: ${GOAL}\n\n` +
    "REGOLE, non negoziabili:\n" +
    "- NON leggere i file del corpus, NON usare Grep su di essi, NON contare niente tu.\n" +
    "- Lancia UNA sessione di lavoro con questo comando Bash, dandole il mandato completo:\n" +
    `  cd ${JSON.stringify(kid)} && claude -p --model ${MODEL} --max-turns 40 --permission-mode acceptEdits --allowedTools ${ALLOWED_TOOLS} "<il mandato>"\n` +
    "- Leggi SOLO la sua risposta finale.\n" +
    `- Poi copia il suo report: cp ${JSON.stringify(join(kid, "report.json"))} ${JSON.stringify(join(dir, "report.json"))}\n` +
    "- Concludi in UNA riga: quale file ne ha di piu' e quante.\n";

  const t0 = Date.now();
  const r = runClaude(dir, prompt);
  const wallClockMs = Date.now() - t0;
  const thread = usageOfNewTranscripts(dir, beforeThread).usage;
  const work = usageOfNewTranscripts(kid, beforeKid).usage;
  const total = readReport(dir);
  return { arm: "coordinator", wallClockMs, exitCode: r.status, thread, work, delivered: total !== null, reportTotal: total, dir };
}

function fmt(n: number): string {
  return n.toLocaleString("it-IT");
}

function main(): void {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : null;
  const keep = argv.includes("--keep");
  const root = mkdtempSync(join(tmpdir(), "thread-vs-work-"));

  const worker = runWorker(root);
  const coord = runCoordinator(root);

  const rows = [worker, coord];
  console.log("");
  console.log("braccio       thread(work tok)   thread(cacheRead)   lavoro delegato   consegnato");
  for (const a of rows) {
    console.log(
      `${a.arm.padEnd(13)} ${fmt(a.thread.billableTokens).padStart(16)} ${fmt(a.thread.cacheReadTokens).padStart(19)} ` +
        `${fmt(a.work.billableTokens).padStart(17)} ${a.delivered ? "si" : "NO"}`,
    );
  }
  const ratio = worker.thread.billableTokens > 0 ? coord.thread.billableTokens / worker.thread.billableTokens : Number.NaN;
  console.log("");
  console.log(`thread del coordinatore / thread del worker = ${Number.isFinite(ratio) ? ratio.toFixed(2) : "?"}`);
  console.log(
    `totale (thread + lavoro): worker ${fmt(worker.thread.billableTokens)} · coordinatore ${fmt(coord.thread.billableTokens + coord.work.billableTokens)} — informativo, non un cancello`,
  );

  const bundle = { measuredAt: new Date().toISOString(), model: MODEL, corpus: CORPUS, goal: GOAL, arms: rows, threadRatio: ratio };
  if (out) writeFileSync(resolve(out), JSON.stringify(bundle, null, 2));
  if (!keep) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }

  const problems: string[] = [];
  for (const a of rows) if (!a.delivered) problems.push(`${a.arm}: non ha consegnato report.json, il suo costo non e' confrontabile`);
  if (coord.work.billableTokens === 0) problems.push("coordinatore: nessuna sessione di lavoro misurata, ha fatto tutto lui");
  if (!(coord.thread.billableTokens < worker.thread.billableTokens)) {
    problems.push(
      `il thread NON si assottiglia: coordinatore ${fmt(coord.thread.billableTokens)} vs worker ${fmt(worker.thread.billableTokens)}`,
    );
  }
  if (problems.length) {
    console.log("");
    for (const p of problems) console.log(`ROSSO · ${p}`);
    process.exit(1);
  }
  console.log("");
  console.log("VERDE · il thread si assottiglia");
}

main();
