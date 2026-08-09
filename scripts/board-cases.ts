#!/usr/bin/env bun
/**
 * scripts/board-cases.ts — LA MATRICE DEI CASI LIMITE della board Kanban.
 *
 * ── La domanda ───────────────────────────────────────────────────────────────
 * «Da oggi la board può essere l'unico punto d'ingresso del lavoro, al posto di
 * aprire una chat?» Il costo in token lo misura l'altro braccio
 * (scripts/board-vs-chat.ts, che chiama anche questo). Qui si misura l'altra
 * metà: **c'è una strada sulla board per ogni caso limite, e quanto costa in
 * GESTI UMANI?**
 *
 * ── La regola di questo file ─────────────────────────────────────────────────
 * Una riga della matrice sostenuta solo dalla LETTURA del sorgente è bocciata.
 * Ogni riga porta almeno una PROVA ESEGUITA da questo script:
 *
 *   • `bun-test`  — un test esistente lanciato adesso come sottoprocesso; il
 *                   suo esito è la prova (comando ricopiabile nel report).
 *   • `probe`     — un'asserzione in-process contro i moduli VERI del server
 *                   (permission-bridge, human-hold, ask-user-bridge, il
 *                   profilo MCP di dispatch). Nessun mock del soggetto.
 *   • `source`    — un'asserzione STRUTTURALE sul codice, e serve quasi solo a
 *                   provare i NEGATIVI («sulla card non c'è»): un negativo non
 *                   ha un test che lo esegua, ma questa asserzione fallisce il
 *                   giorno in cui qualcuno aggiunge la superficie mancante — e
 *                   quel giorno la matrice va riscritta. È una rete, non un
 *                   parere. Non basta MAI da sola: ogni caso ha anche un
 *                   `bun-test` o un `probe`.
 *   • `http-get`  — un GET in sola lettura contro il server VIVO su :3333
 *                   (self-signed, loopback). È corroborazione sul campo, e può
 *                   mancare (server giù) → allora la prova è `skipped`, MAI
 *                   contata come passata. Nessun caso dipende solo da lei.
 *
 * ── Il cancello ──────────────────────────────────────────────────────────────
 * Esce 0 se e solo se: ogni caso ha ≥1 prova ESEGUITA (non-skipped) e nessuna
 * prova eseguita è rossa. Un caso il cui verdetto è `gap` NON fa uscire 1: un
 * buco misurato è un risultato, e la prova che lo sostiene è ciò che lo terrà
 * onesto quando cambierà.
 *
 * ── Cos'è «un'azione umana» ──────────────────────────────────────────────────
 * Un gesto discreto e indivisibile nell'interfaccia: **un click**, oppure **un
 * invio di testo** (digitare e premere Invio è UNO — è una sola consegna).
 * NON contano: leggere, scorrere, aprire un pannello per guardare quando la
 * stessa decisione è raggiungibile senza aprirlo. Contano invece i gesti di
 * NAVIGAZIONE necessari a raggiungere il controllo (aprire il tab dell'agente
 * per premere un bottone che sulla card non c'è).
 *
 * ── Come si aggancia alla barra composta ─────────────────────────────────────
 * `scripts/board-vs-chat.ts` non importa questo modulo: legge la matrice da
 * `docs/board-vs-chat/cases.json` (schemaVersion 1). `--emit-cases` scrive quel
 * file mettendo, per ogni riga, un comando corto e rieseguibile
 * (`bun scripts/board-cases.ts --case <id>`) con l'exit code osservato
 * facendolo girare davvero.
 *
 * Uso:
 *   bun scripts/board-cases.ts               # tabella leggibile, esce 1 se rossa
 *   bun scripts/board-cases.ts --json        # la stessa cosa in JSON
 *   bun scripts/board-cases.ts --case 3      # un caso solo (la prova ricopiabile)
 *   bun scripts/board-cases.ts --emit-cases  # scrive docs/board-vs-chat/cases.json
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Moduli VERI del server. Tutti puri (nessun DB, nessun timer al caricamento):
// permission-bridge e ask-user-bridge sono due Map in memoria, human-hold le
// interroga, topics-mcp-server ha la guardia `import.meta.main` sul suo main().
import {
  beginPermission,
  deliverDecision,
  endPermission,
  hasPendingPermission,
  resolvePendingPermission,
  aliasPermission,
  cancelPermissionsForSession,
  pendingPermissionAgeMs,
  PERMISSION_TTL_MS,
} from "../server/lib/permission-bridge";
import { beginAsk, cancelAsk, hasPendingAsk } from "../server/lib/ask-user-bridge";
import { isHumanHold, humanHoldAgeMs, releaseHumanHold } from "../server/lib/human-hold";
import { detectUserInputRequest } from "../server/providers/ask-user-detector";
import { toolsForProfile, isToolAllowedForProfile } from "../server/mcp/topics-mcp-server";
import { PERMISSION_PROMPT_TOOL } from "../server/lib/autonomy-mode";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_ID = "topics-app-ar3jt5";
const BASE = "https://localhost:3333";

/**
 * La soglia della migration 048 (agent_cache_read_tokens + dedup per
 * `message.id`): i task con token registrati PRIMA sono gonfiati ~2,4× e non
 * sono comparabili con quelli dopo.
 *
 * Si LEGGE da `schema_migrations`, non si cabla: la data del commit che porta
 * il file e l'istante in cui la migration è stata APPLICATA a questo DB sono
 * due cose diverse, e cablarne una qui creerebbe una seconda aritmetica
 * accanto a quella di `scripts/board-vs-chat.ts` — cioè esattamente il difetto
 * che quel file dichiara di non volere. Readonly, sempre.
 */
export function migration048At(): { at: number | null; source: string } {
  const dbPath = resolve(ROOT, "data/topics.db");
  if (!existsSync(dbPath)) return { at: null, source: "data/topics.db assente" };
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT applied_at FROM schema_migrations WHERE name LIKE '048-%' ORDER BY version LIMIT 1")
        .get() as { applied_at?: string } | undefined;
      const at = row?.applied_at ? Date.parse(row.applied_at) : NaN;
      if (Number.isFinite(at)) return { at, source: `schema_migrations.applied_at = ${row?.applied_at}` };
      return { at: null, source: "nessuna riga 048-% in schema_migrations" };
    } finally {
      db.close();
    }
  } catch (err) {
    return { at: null, source: `DB non leggibile: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prove
// ─────────────────────────────────────────────────────────────────────────────

export type ProofKind = "bun-test" | "probe" | "source" | "http-get";
export type ProofStatus = "pass" | "fail" | "skipped";

export interface Proof {
  kind: ProofKind;
  /** Cosa dimostra, in una riga. */
  claim: string;
  /** Comando ricopiabile (o la descrizione dell'asserzione in-process). */
  command: string;
  status: ProofStatus;
  /** Output rilevante — è ciò che finisce nel report al posto di «l'ho letto». */
  detail: string;
  /**
   * I file del repo che questa prova LEGGE (test eseguito, sorgente ispezionato).
   * Non è decorazione: è l'insieme che finisce nell'impronta di `cases.json`, ed
   * è ciò che lega la matrice congelata sul disco alle sorgenti che pretende di
   * coprire. Le prove che non leggono file (http-get, probe in-process) non ne
   * hanno.
   */
  files?: string[];
}

const proofs: Proof[] = [];

/**
 * L'IMPRONTA delle sorgenti su cui poggia la matrice.
 *
 * `docs/board-vs-chat/cases.json` è una matrice CONGELATA: dentro c'è l'esito
 * osservato di ogni prova, e `scripts/board-vs-chat.ts` si fida di quell'esito
 * invece di rieseguire (rieseguire costa ~5,5s e vuole il server vivo). Finché
 * niente lega il file alle sorgenti che copre, un refactor che rompe la matrice
 * lascia la barra verde: il difetto peggiore possibile qui, perché è la barra a
 * dover accorgersene.
 *
 * L'impronta chiude il giro: `--emit-cases` registra lo sha256 di ogni file che
 * le prove leggono (più questo file, che le prove le SCRIVE), e la barra rifà i
 * conti. Se un byte cambia, `cases.json` è dichiarato STANTIO e va rigenerato —
 * non aggiustato a mano.
 */
export interface MatrixFingerprint {
  algo: "sha256";
  /** Path relativo alla radice del repo → sha256 esadecimale, o `ASSENTE`. */
  files: Record<string, string>;
}

/** Il timbro di un file mancante. Esplicito: un file che RIAPPARE è una deriva
 *  quanto uno che sparisce, e un `undefined` non la distinguerebbe. */
export const FINGERPRINT_ABSENT = "ASSENTE";

export function fingerprintFiles(paths: string[], root: string): MatrixFingerprint {
  const files: Record<string, string> = {};
  for (const rel of [...new Set(paths)].sort()) {
    const abs = resolve(root, rel);
    files[rel] = existsSync(abs)
      ? createHash("sha256").update(readFileSync(abs)).digest("hex")
      : FINGERPRINT_ABSENT;
  }
  return { algo: "sha256", files };
}

/**
 * `bun test -t` prende una REGEX, non una sottostringa: un filtro che contiene
 * `(`, `+` o `?` non matcha il titolo letterale e il test «passa» a zero test
 * eseguiti — cioè una prova che non può fallire, travestita da verde. Qui i
 * metacaratteri sono un errore duro invece che un silenzio.
 */
export const REGEX_META = /[()[\]{}+*?^$|\\]/;

function bunTest(claim: string, file: string, nameFilter?: string): Proof {
  const args = ["test", file, ...(nameFilter ? ["-t", nameFilter] : [])];
  const command = `bun ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;
  if (nameFilter && REGEX_META.test(nameFilter)) {
    return {
      kind: "bun-test",
      claim,
      command,
      status: "fail",
      detail: `filtro con metacaratteri regex (${nameFilter}): -t non matcherebbe il titolo letterale`,
      files: [file],
    };
  }
  const res = spawnSync("bun", args, { cwd: ROOT, encoding: "utf8" });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? "0");
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? "0");
  const ok = res.status === 0 && fail === 0 && pass > 0;
  return {
    kind: "bun-test",
    claim,
    command,
    status: ok ? "pass" : "fail",
    detail: `${pass} pass, ${fail} fail (exit ${res.status ?? "null"})`,
    files: [file],
  };
}

/** Asserzione in-process contro i moduli veri. `fn` torna il dettaglio da
 *  stampare; se lancia, la prova è rossa col messaggio dell'eccezione. */
function probe(claim: string, label: string, fn: () => string): Proof {
  try {
    return { kind: "probe", claim, command: `probe: ${label}`, status: "pass", detail: fn() };
  } catch (err) {
    return {
      kind: "probe",
      claim,
      command: `probe: ${label}`,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Asserzione strutturale sul sorgente. Usata per i NEGATIVI (cosa la board non
 * espone) e per gli ORDINI (chi viene prima di chi in una rotta): sono fatti che
 * nessun test esegue, ma che questa riga fa diventare rossi se cambiano.
 */
export function sourceAssert(
  claim: string,
  file: string,
  opts: { contains?: string[]; absent?: string[]; before?: [string, string] },
): Proof {
  const rel = file;
  const abs = resolve(ROOT, file);
  const parts: string[] = [];
  const command = `grep-assert ${rel}`;
  if (!existsSync(abs)) {
    return { kind: "source", claim, command, status: "fail", detail: `file mancante: ${rel}`, files: [rel] };
  }
  const src = readFileSync(abs, "utf8");
  try {
    for (const needle of opts.contains ?? []) {
      must(src.includes(needle), `atteso ma assente in ${rel}: ${JSON.stringify(needle)}`);
      parts.push(`c'è ${JSON.stringify(needle)}`);
    }
    for (const needle of opts.absent ?? []) {
      must(!src.includes(needle), `NON atteso ma presente in ${rel}: ${JSON.stringify(needle)}`);
      parts.push(`assente ${JSON.stringify(needle)}`);
    }
    if (opts.before) {
      const [first, second] = opts.before;
      const i = src.indexOf(first);
      const j = src.indexOf(second, i >= 0 ? i : 0);
      must(i >= 0, `assente in ${rel}: ${first}`);
      must(j > i, `ordine sbagliato in ${rel}: ${first} deve precedere ${second}`);
      parts.push(`${first} precede ${second}`);
    }
    return { kind: "source", claim, command, status: "pass", detail: parts.join("; "), files: [rel] };
  } catch (err) {
    return {
      kind: "source",
      claim,
      command,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      files: [rel],
    };
  }
}

/**
 * Cerca in OGNI file di una lista. Un file mancante è un ERRORE, non un file da
 * saltare: un elenco che si accorcia da solo trasformerebbe questa asserzione
 * nell'unica cosa peggiore di un'asserzione sbagliata — una che non può fallire.
 */
export function sourceAbsentIn(claim: string, files: string[], needles: string[]): Proof {
  const command = `grep -L {${needles.join(",")}} — ${files.length} file`;
  const hits: string[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const abs = resolve(ROOT, f);
    if (!existsSync(abs)) {
      missing.push(f);
      continue;
    }
    const src = readFileSync(abs, "utf8");
    for (const n of needles) if (src.includes(n)) hits.push(`${f}: ${n}`);
  }
  if (missing.length) {
    return { kind: "source", claim, command, status: "fail", detail: `file mancanti: ${missing.join(", ")}`, files: [...files] };
  }
  return {
    kind: "source",
    claim,
    command,
    status: hits.length === 0 ? "pass" : "fail",
    detail: hits.length === 0 ? `${files.length} file letti, 0 occorrenze` : `occorrenze: ${hits.join(", ")}`,
    files: [...files],
  };
}

export interface BoardTask {
  id: string;
  status: string;
  dispatchState: string | null;
  assignedTopicId: string | null;
  agentTokens: number | null;
  agentCacheReadTokens: number | null;
  planFirst: boolean;
  previewImage: string | null;
  deliveredBy: string | null;
  dispatchAttempts: number | null;
  completedAt: string | null;
  updatedAt: string;
}

/** Lo STESSO timbro che usa `isComparableTaskRow` in scripts/board-vs-chat.ts —
 *  due timbri diversi darebbero due conteggi diversi sullo stesso fatto. */
function comparableStamp(t: BoardTask): string {
  return t.completedAt ?? t.updatedAt;
}

let boardCache: BoardTask[] | null = null;
let boardError: string | null = null;

async function loadBoard(): Promise<BoardTask[] | null> {
  if (boardCache || boardError) return boardCache;
  try {
    const res = await fetch(`${BASE}/api/boards/${BOARD_ID}/tasks`, {
      // Loopback self-signed: il certificato non è la cosa che stiamo provando.
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(8000),
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { tasks?: BoardTask[] };
    boardCache = Array.isArray(body.tasks) ? body.tasks : [];
    return boardCache;
  } catch (err) {
    boardError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/**
 * GET in sola lettura sul server vivo.
 *
 * Le due cause di guaio NON sono la stessa cosa e non devono finire nello stesso
 * esito, o la prova smette di poter fallire:
 *  · il server non risponde / non è 2xx / non è JSON → `skipped`. Il fatto
 *    dichiarato non è stato messo alla prova: nessuno sa se regge.
 *  · `check` LANCIA (un `must` non tiene) → `fail`. Il fatto è stato messo alla
 *    prova ed è caduto. Prima anche questo diventava `skipped`, e un `must`
 *    dentro `check` sarebbe stato decorativo.
 */
async function httpProof(
  claim: string,
  path: string,
  check: (body: unknown) => string,
): Promise<Proof> {
  const command = `curl -sk ${BASE}${path}`;
  let body: unknown;
  try {
    const res = await fetch(`${BASE}${path}`, {
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(8000),
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    return {
      kind: "http-get",
      claim,
      command,
      status: "skipped",
      detail: `server vivo non interrogabile: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return { kind: "http-get", claim, command, status: "pass", detail: check(body) };
  } catch (err) {
    return {
      kind: "http-get",
      claim,
      command,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Il denominatore di un censimento sulla board.
 *
 * Contare «quanti task hanno X» su una colonna che l'API ha smesso di servire
 * legge `undefined` a ogni riga e stampa «0 su 153»: un verde che dice il
 * contrario di quello che sembra. Qui la colonna deve ESISTERE nel payload,
 * altrimenti il censimento è rosso invece che vuoto — è l'unico modo di far
 * fallire una riga che per il resto si limita a contare.
 */
export function mustColumns(tasks: BoardTask[], ...keys: Array<keyof BoardTask>): void {
  must(tasks.length > 0, "la board risponde ma non ha nemmeno un task: il censimento non ha denominatore");
  for (const k of keys) {
    must(
      tasks.some((t) => Object.prototype.hasOwnProperty.call(t, k)),
      `il payload della board non porta (più) la colonna «${String(k)}»: il censimento conterebbe undefined`,
    );
  }
}

async function boardProof(claim: string, check: (tasks: BoardTask[]) => string): Promise<Proof> {
  const command = `curl -sk ${BASE}/api/boards/${BOARD_ID}/tasks`;
  const tasks = await loadBoard();
  if (!tasks) {
    return {
      kind: "http-get",
      claim,
      command,
      status: "skipped",
      detail: `board viva non interrogabile: ${boardError ?? "?"}`,
    };
  }
  try {
    return { kind: "http-get", claim, command, status: "pass", detail: check(tasks) };
  } catch (err) {
    return {
      kind: "http-get",
      claim,
      command,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// La matrice
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = "covered" | "partial" | "gap";

export interface CaseRow {
  id: string;
  title: string;
  /** Cosa succede sulla BOARD. */
  board: string;
  /** Cosa succede in CHAT (lo stesso fatto, altro braccio). */
  chat: string;
  /** Il gesto umano richiesto, e quanti ne servono, sulla board. */
  gesture: string;
  humanActionsBoard: number;
  humanActionsChat: number;
  verdict: Verdict;
  /**
   * I moduli di cui QUESTA riga parla, dichiarati a mano.
   *
   * Serve perché l'impronta costruita dai soli `proof.files` aveva un buco
   * grande quanto la matrice: `probe()` non porta nessun file (asserisce
   * in-process contro moduli importati in testa a questo file) e `bunTest()`
   * porta solo il `.test.ts`, mai il modulo sotto esame. Risultato misurato:
   * dieci moduli — permission-bridge, ask-user-bridge, human-hold,
   * autonomy-mode, plan-approval, ask-user-detector, turn-watchdog,
   * topics-mcp-server, approval-prompt, transcript-usage — restavano FUORI
   * dall'impronta, e le righe che li riguardano sarebbero rimaste verdi anche
   * dopo averli riscritti da zero. Una rete anti-staleness cieca proprio sul
   * soggetto è peggio di nessuna rete: dà la sicurezza senza darla.
   *
   * Regola: se una riga afferma qualcosa su un file, quel file va qui. Un
   * percorso inesistente è un errore duro, non una voce da saltare.
   */
  subjects: string[];
  /** Indici dentro l'array globale `proofs`. */
  proofIdx: number[];
}

const cases: CaseRow[] = [];

function addCase(row: Omit<CaseRow, "proofIdx">, rowProofs: Proof[]): void {
  // Una riga senza soggetti dichiarati non è coperta dalla rete: si accorgerebbe
  // di una deriva nei suoi test ma non nel codice che descrive. Errore duro,
  // qui e adesso, invece di un verde che invecchia in silenzio.
  if (row.subjects.length === 0) {
    throw new Error(`caso ${row.id}: nessun soggetto dichiarato — vedi CaseRow.subjects`);
  }
  const assenti = row.subjects.filter((f) => !existsSync(resolve(ROOT, f)));
  if (assenti.length) {
    throw new Error(`caso ${row.id}: soggetti inesistenti (${assenti.join(", ")}) — un percorso morto toglie il file dall'impronta senza dirlo`);
  }
  const idx: number[] = [];
  for (const p of rowProofs) {
    idx.push(proofs.length);
    proofs.push(p);
  }
  cases.push({ ...row, proofIdx: idx });
}

/**
 * La superficie BOARD, enumerata dalla CARTELLA e non da un elenco scritto a
 * mano: un negativo («sulla board non c'è») vale quanto la superficie su cui è
 * stato cercato, e una lista compilata a mano invecchia verso il verde ogni
 * volta che qualcuno aggiunge un componente. Fuori restano solo i file di test.
 */
const BOARD_DIR = "client/src/components/Board";
const BOARD_SURFACE: string[] = readdirSync(resolve(ROOT, BOARD_DIR))
  .filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.includes(".test."))
  .sort()
  .map((f) => `${BOARD_DIR}/${f}`);

/** Tutti gli id della matrice, nell'ordine in cui `build` li costruisce. */
export const CASE_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] as const;

/**
 * `only` costruisce UN caso solo. Non è un vezzo: è ciò che rende
 * `bun scripts/board-cases.ts --case 3` un comando corto e ricopiabile, e
 * quindi una prova che chi legge il report può rieseguire senza aspettare gli
 * altri nove.
 */
async function build(only?: string): Promise<void> {
  const want = (id: string): boolean => only === undefined || only === id;
  // ── 1. L'AGENTE FA UNA DOMANDA ────────────────────────────────────────────
  if (want("1")) addCase(
    {
      id: "1",
      title: "L'agente fa una domanda",
      board:
        "DUE canali, e solo uno arriva sulla card. (a) Il canale della board — " +
        "comment_task(options=[…]) + status=review: il server compone lui il blocco " +
        "```question, la card lo rende con un bottone per opzione e il chip diventa " +
        "needs_input («serve te»). (b) mcp__topics__ask_user_question NON è escluso " +
        "per gli agenti di dispatch: un agente può aprire il pannello IN CHAT a metà " +
        "turno — lì il turno resta vivo (isHumanHold disarma watchdog, reaper e tetto " +
        "di vita) ma la card resta 'working' e non mostra niente.",
      chat: "Il pannello a bottoni è nativo nel thread; il turno resta bloccato sulla risposta JSON-RPC del bridge.",
      gesture:
        "canale (a): 1 click sul bottone dell'opzione sulla card (→ POST /review reject+comment → reviewDecision + dispatcher.resume). " +
        "canale (b): 1 click «apri tab» + 1 click sull'opzione = 2.",
      humanActionsBoard: 1,
      humanActionsChat: 1,
      verdict: "partial",
      subjects: [
        "server/providers/ask-user-detector.ts",
        "server/lib/ask-user-bridge.ts",
        "server/lib/human-hold.ts",
        "server/mcp/topics-mcp-server.ts",
        "server/routes/tasks.ts",
        "server/services/task-dispatcher.ts",
      ],
    },
    [
      bunTest(
        "comment_task(options) → il SERVER compone il blocco ```question (unico scrittore)",
        "server/routes/tasks.test.ts",
        "server-composed question block",
      ),
      bunTest(
        "una domanda come ultima parola dell'agente ribalta il chip su needs_input",
        "server/services/task-dispatcher.test.ts",
        "flips the chip to needs_input",
      ),
      bunTest(
        "il giro completo del pannello in chat: tool_use → pending → tool_result su stdin",
        "server/providers/ask-user-flow.test.ts",
      ),
      bunTest(
        "il rilevatore riconosce AskUserQuestion, il bridge MCP e l'elicitation",
        "server/providers/ask-user-detector.test.ts",
      ),
      probe(
        "una domanda aperta tiene il turno VIVO: isHumanHold vero, e senza scadenza",
        "beginAsk → isHumanHold → cancelAsk",
        () => {
          const sk = "topic:probe-ask";
          must(!isHumanHold(sk), "partenza sporca: hold già attivo");
          must(beginAsk(sk), "beginAsk ha rifiutato di aprire la domanda");
          must(hasPendingAsk(sk), "la domanda non risulta aperta");
          must(isHumanHold(sk), "una domanda aperta DEVE valere come attesa umana");
          const dayLater = Date.now() + 23 * 60 * 60 * 1000;
          must(
            isHumanHold(sk, dayLater),
            "la domanda deve restare un'attesa anche 23h dopo (chi risponde la mattina dopo)",
          );
          const age = humanHoldAgeMs(sk, dayLater);
          must(age !== null && age > 22 * 60 * 60 * 1000, "l'età dell'attesa non è quella vera");
          cancelAsk(sk, "probe");
          must(!isHumanHold(sk), "chiusa la domanda l'esenzione deve finire");
          return "hold ON con domanda aperta (anche a 23h), OFF dopo cancelAsk";
        },
      ),
      probe(
        "ask_user_question NON è tolto agli agenti di board: il canale (b) esiste davvero",
        "toolsForProfile('dispatch')",
        () => {
          const names = toolsForProfile("dispatch").map((t) => t.name);
          must(names.includes("ask_user_question"), "ask_user_question risulta escluso dal profilo dispatch");
          must(names.includes("comment_task"), "comment_task deve esserci nel profilo dispatch");
          const detected = detectUserInputRequest({
            name: "mcp__topics__ask_user_question",
            input: { questions: [{ question: "q?", options: [{ label: "a" }, { label: "b" }] }] },
          });
          must(detected?.kind === "questions", "il rilevatore non riconosce il tool bridge");
          return `profilo dispatch: ${names.length} tool, ask_user_question incluso; il rilevatore lo classifica 'questions'`;
        },
      ),
      sourceAssert(
        "la card rende il blocco question e risponde con un reject che porta il testo",
        "client/src/components/Board/Card.tsx",
        { contains: ["parseQuestionBlock", "answer(opt)", "review('reject', text)"] },
      ),
      sourceAbsentIn(
        "NEGATIVO: nessuna superficie della board conosce il pannello di domanda in-chat",
        BOARD_SURFACE,
        ["pendingAsk", "userInputRequest", "ask_user_question"],
      ),
      await boardProof(
        "censimento: quanti task portano il chip needs_input adesso (conta, non asserisce; " +
          "rossa solo se la colonna sparisce dal payload)",
        (t) => {
          mustColumns(t, "dispatchState");
          const n = t.filter((x) => x.dispatchState === "needs_input").length;
          return `${n} task con dispatchState=needs_input su ${t.length}`;
        },
      ),
    ],
  );

  // ── 2. PERMESSO RICHIESTO ─────────────────────────────────────────────────
  if (want("2")) addCase(
    {
      id: "2",
      title: "Permesso richiesto (--permission-prompt-tool)",
      board:
        "INVISIBILE sulla card. Il pannello lo dipinge la rotta " +
        "POST /api/sessions/:sk/permission sulla RIGA DI TOOL nella chat della " +
        "sessione, agganciata per sessionKey+tool_use_id; nessun componente della " +
        "board legge permissionRequest/awaiting_permission. Il chip resta 'working'. " +
        "Il segnale c'è ma su un'ALTRA superficie: /api/topics/streaming dichiara la " +
        "sessione state='waiting' (via humanHoldAgeMs), cioè il tab dell'agente in " +
        "sidebar dice «aspetta te».",
      chat: "Il pannello è sulla riga di tool nel thread: si decide dove si sta già guardando.",
      gesture: "1 click «apri tab» dalla card + 1 click su allow/deny nel thread = 2.",
      humanActionsBoard: 2,
      humanActionsChat: 1,
      verdict: "gap",
      subjects: [
        "server/lib/permission-bridge.ts",
        "server/lib/autonomy-mode.ts",
        "server/mcp/topics-mcp-server.ts",
        "server/lib/human-hold.ts",
      ],
    },
    [
      bunTest(
        "il rendez-vous per sessionKey+tool_use_id: gambe, dispensa, alias, chiusure, TTL",
        "server/lib/permission-bridge.test.ts",
      ),
      bunTest(
        "`cancelled` chiude con un NO, non con un sì",
        "server/mcp/approval-prompt.test.ts",
        "chiude con un NO",
      ),
      bunTest(
        "Topics irraggiungibile oltre la grazia → deny (nessun sì per inerzia)",
        "server/mcp/approval-prompt.test.ts",
        "Topics irraggiungibile",
      ),
      bunTest(
        "un server incastrato su `pending` finisce le gambe e NEGA",
        "server/mcp/approval-prompt.test.ts",
        "finisce le gambe e nega",
      ),
      probe(
        "consegnare a una richiesta che non è aperta torna FALSO: nessun sì al buio",
        "deliverDecision/resolvePendingPermission su permission-bridge",
        () => {
          const sk = "topic:probe-perm";
          cancelPermissionsForSession(sk, "reset probe");
          must(
            deliverDecision(sk, "tool-inesistente", "allow") === false,
            "una decisione consegnata nel vuoto è stata accettata",
          );
          must(beginPermission(sk, "tu-1"), "beginPermission ha rifiutato la prima richiesta");
          must(hasPendingPermission(sk, "tu-1"), "la richiesta non risulta aperta");
          must(
            resolvePendingPermission(sk, "riga-scollegata") === null,
            "un id sconosciuto si è risolto: sarebbe un sì dato al posto di un altro",
          );
          aliasPermission(sk, "tu-1", "riga-scollegata");
          must(
            resolvePendingPermission(sk, "riga-scollegata") === "tu-1",
            "un alias SCRITTO deve risolversi",
          );
          must(deliverDecision(sk, "tu-1", "deny") === true, "la decisione non è stata consegnata");
          must(!hasPendingPermission(sk, "tu-1"), "la richiesta doveva chiudersi");
          endPermission(sk, "tu-1");
          return "vuoto→false, id sconosciuto→null, alias scritto→risolve, consegna→chiude";
        },
      ),
      probe(
        "un permesso aperto disarma le reti di sicurezza, ma SOLO entro il suo TTL (2h)",
        "pendingPermissionAgeMs + isHumanHold oltre PERMISSION_TTL_MS",
        () => {
          const sk = "topic:probe-perm-ttl";
          cancelPermissionsForSession(sk, "reset probe");
          const t0 = Date.now();
          must(beginPermission(sk, "tu-ttl", PERMISSION_TTL_MS, t0), "apertura fallita");
          must(isHumanHold(sk, t0 + 60_000), "entro il TTL il permesso è un'attesa vera");
          must(
            !isHumanHold(sk, t0 + PERMISSION_TTL_MS + 1),
            "oltre il TTL le reti devono tornare ad avere i denti (fantasma del 7 agosto)",
          );
          const age = pendingPermissionAgeMs(sk, t0 + 60_000);
          must(age !== null && age >= 60_000, "l'età della richiesta non è quella vera");
          releaseHumanHold(sk, "probe");
          must(pendingPermissionAgeMs(sk) === null, "releaseHumanHold deve chiudere anche i permessi");
          return `TTL=${Math.round(PERMISSION_TTL_MS / 60000)}min: hold ON dentro, OFF fuori; releaseHumanHold chiude entrambe le sorgenti`;
        },
      ),
      probe(
        "il canale di permesso è pubblicato SEMPRE, anche nel profilo ridotto degli agenti di board",
        "isToolAllowedForProfile('dispatch', 'approval_prompt')",
        () => {
          must(
            isToolAllowedForProfile("dispatch", "approval_prompt"),
            "approval_prompt non è chiamabile nel profilo dispatch: ogni permesso sarebbe un no muto",
          );
          must(
            PERMISSION_PROMPT_TOOL === "mcp__topics__approval_prompt",
            `il tool designato è cambiato: ${PERMISSION_PROMPT_TOOL}`,
          );
          return `--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}, chiamabile nel profilo dispatch`;
        },
      ),
      sourceAbsentIn(
        "NEGATIVO: nessuna superficie della board sa cos'è una richiesta di permesso",
        BOARD_SURFACE,
        ["permissionRequest", "awaiting_permission", "approval_prompt"],
      ),
      sourceAssert(
        "il segnale «aspetta te» esiste, ma sulla superficie SESSIONI",
        "server/routes/topics.ts",
        { contains: ["/api/topics/streaming", "humanHoldAgeMs(topic.sessionKey)", '"waiting"'] },
      ),
      await httpProof(
        "sul campo: la rotta che porta il segnale «waiting» risponde con lo snapshot delle sessioni",
        "/api/topics/streaming",
        (body) => {
          // L'asserzione è la FORMA del payload, non il conteggio: zero sessioni
          // vive è uno stato legittimo, un payload senza `sessions` no — sarebbe
          // la rotta su cui il caso 2 appoggia il suo unico segnale, andata via.
          const b = body as { sessions?: unknown };
          must(isRecord(body), "risposta non-oggetto da /api/topics/streaming");
          must(Array.isArray(b.sessions), "payload senza array `sessions`: il segnale «waiting» non ha più dove passare");
          const sessions = b.sessions as unknown[];
          const waiting = sessions.filter((s) => isRecord(s) && s.state === "waiting").length;
          return `/api/topics/streaming → ${sessions.length} sessioni nello snapshot, di cui ${waiting} in state="waiting"`;
        },
      ),
    ],
  );

  // ── 3. SESSIONE GUARDABILE ────────────────────────────────────────────────
  if (want("3")) addCase(
    {
      id: "3",
      title: "Guardare la sessione viva sotto il task",
      board:
        "Sì, per intero e senza aprire niente: il drawer deriva la sessione dal task " +
        "(sessionKey = 'topic:' + assignedTopicId.slice(0,8)), legge /api/history/:sk, " +
        "la polla ogni 3s mentre l'agente lavora e intercala le SLICE della sessione fra " +
        "un commento e l'altro, con la coda dell'ultimo messaggio come anteprima. Un " +
        "click su «apri tab» porta alla chat vera, dove si può intervenire — e " +
        "intervenire NON rompe il dispatch: scrivere lì è un messaggio in più sulla " +
        "stessa sessione, il legame task↔topic resta.",
      chat: "È la chat: si guarda e si scrive nello stesso posto.",
      gesture: "0 per leggere l'anteprima sulla card/nel drawer; 1 click per aprire il tab vivo.",
      humanActionsBoard: 0,
      humanActionsChat: 0,
      verdict: "covered",
      subjects: [
        "server/services/task-dispatcher.ts",
        "server/routes/topics.ts",
      ],
    },
    [
      bunTest(
        "il legame task↔topic è quello che il dispatcher usa per riprendere la STESSA sessione",
        "server/services/task-dispatcher.test.ts",
        "resume re-kicks the SAME topic with the human message",
      ),
      sourceAssert(
        "il drawer deriva la sessione dal task, la legge e la polla mentre l'agente lavora",
        "client/src/components/Board/TaskDetail.tsx",
        {
          contains: [
            "`topic:${task.assignedTopicId.slice(0, 8)}`",
            "/api/history/",
            "setInterval(() => { void loadSession(); }, 3000)",
            "onOpenTopic",
          ],
        },
      ),
      sourceAssert(
        "il dispatcher deriva la STESSA chiave: quello che il drawer legge è la sessione dell'agente",
        "server/services/task-dispatcher.ts",
        { contains: ['"topic:" + t.assignedTopicId.slice(0, 8)'] },
      ),
      await boardProof(
        "censimento: quanti task hanno una sessione raggiungibile dal drawer (conta; rossa se " +
          "il payload perde assignedTopicId, cioè se il binding task↔sessione sparisce)",
        (t) => {
          mustColumns(t, "assignedTopicId");
          const bound = t.filter((x) => x.assignedTopicId).length;
          return `${bound} task su ${t.length} hanno assignedTopicId (→ sessione leggibile dal drawer)`;
        },
      ),
      await (async (): Promise<Proof> => {
        const tasks = await loadBoard();
        const target = tasks
          ?.filter((x) => x.assignedTopicId && (x.agentTokens ?? 0) > 0)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!target?.assignedTopicId) {
          return {
            kind: "http-get",
            claim: "sul campo: la storia della sessione di un task vero è leggibile",
            command: `curl -sk ${BASE}/api/history/topic:<id>`,
            status: "skipped",
            detail: `nessun task interrogabile: ${boardError ?? "nessun task con sessione e token"}`,
          };
        }
        const sk = `topic:${target.assignedTopicId.slice(0, 8)}`;
        return httpProof(
          "sul campo: la storia della sessione di un task vero è leggibile dal suo binding",
          `/api/history/${encodeURIComponent(sk)}?limit=5`,
          (body) => {
            const b = body as { messages?: unknown };
            must(isRecord(body), "risposta non-oggetto da /api/history");
            must(Array.isArray(b.messages), "payload senza array `messages`: il drawer non avrebbe niente da mostrare");
            const msgs = b.messages as unknown[];
            // La chiave è DERIVATA dal task: se il binding non porta a una
            // sessione con messaggi, il caso 3 («si guarda senza aprire niente»)
            // è falso su un task che ha davvero lavorato.
            must(msgs.length > 0, `${sk} esiste ma non ha messaggi: il binding task↔sessione non porta a niente di leggibile`);
            return `${sk} → ${msgs.length} messaggi (derivato da assignedTopicId del task ${target.id.slice(0, 8)})`;
          },
        );
      })(),
    ],
  );

  // ── 4. CICLO DI FEEDBACK ──────────────────────────────────────────────────
  if (want("4")) addCase(
    {
      id: "4",
      title: "Ciclo di feedback su un task in review",
      board:
        "UNA richiesta, un gesto. Il click su un'opzione (o l'Invio nel campo " +
        "«Rispondi…») è un POST /review con decision='reject' e il testo come comment: " +
        "il server chiama reviewDecision(reject) — che riporta il task a in_progress — e " +
        "SOLO DOPO dispatcher.resume sulla STESSA sessione. L'ordine è dentro una sola " +
        "richiesta, quindi dall'interfaccia non si può sbagliare. Sbagliarlo si può da " +
        "API grezza: POST /comments risveglia l'agente solo se la radice è in review o " +
        "in_progress — un commento su un task in todo/backlog resta una nota che " +
        "l'agente non vedrà mai. A turno VIVO il resume non si perde: viene bufferato " +
        "(pendingResume) e consegnato al confine del turno.",
      chat: "Si scrive nel composer: 1 invio di testo. Se il turno è in volo la CLI accoda il messaggio.",
      gesture:
        "1 click sull'opzione, oppure 1 invio di testo nel campo della card. Sul thread di uno STEP: 1 click per aprire il drawer + 1 invio = 2.",
      humanActionsBoard: 1,
      humanActionsChat: 1,
      verdict: "covered",
      subjects: [
        "server/routes/tasks.ts",
        "server/services/tasks.ts",
        "server/services/task-dispatcher.ts",
      ],
    },
    [
      bunTest(
        "un commento su uno STEP di una radice in review ri-calcia l'agente (reject + resume col riferimento allo step)",
        "server/routes/tasks.test.ts",
        "comment on a STEP of a root in review re-kicks",
      ),
      bunTest(
        "aggiungere uno step sotto una radice in review ri-calcia l'agente senza cerimonie",
        "server/routes/tasks.test.ts",
        "adding a step under a root in review re-kicks the agent",
      ),
      bunTest(
        "resume riparte sulla STESSA sessione col messaggio umano",
        "server/services/task-dispatcher.test.ts",
        "resume re-kicks the SAME topic with the human message",
      ),
      bunTest(
        "a turno VIVO il messaggio è bufferato e consegnato al confine del turno (non perso, non doppio)",
        "server/services/task-dispatcher.test.ts",
        "buffers a resume landing while the turn is in flight",
      ),
      bunTest(
        "senza legame al topic il resume è un no-op: non nasce un agente nuovo per un commento",
        "server/services/task-dispatcher.test.ts",
        "resume is a no-op when the task has no bound topic",
      ),
      bunTest(
        "gli allegati del commento arrivano all'agente ripreso come path su disco",
        "server/routes/tasks.test.ts",
        "media reaches the thread AND the resumed agent",
      ),
      sourceAssert(
        "ORDINE nella rotta /review: reviewDecision PRIMA, dispatcher.resume DOPO",
        "server/routes/tasks.ts",
        { before: ["const task = svc.reviewDecision({", "dispatcher.resume(bReview.taskId"] },
      ),
      sourceAssert(
        "il risveglio da commento è recintato: solo review o in_progress (altrimenti si sveglierebbe un agente per niente)",
        "server/routes/tasks.ts",
        { contains: ['(root.status === "review" || root.status === "in_progress")'] },
      ),
      sourceAssert(
        "la card manda il testo come reject: rispondere È il ciclo di feedback",
        "client/src/components/Board/Card.tsx",
        { contains: ["const answer = (text: string) => review('reject', text);", "onKeyDown"] },
      ),
    ],
  );

  // ── 5. CONSEGNA SENZA comment_task ────────────────────────────────────────
  if (want("5")) addCase(
    {
      id: "5",
      title: "Consegna senza commento di sintesi",
      board:
        "Due reti, non una — e NESSUNA si chiama ensureAgentSummary (quel nome non " +
        "esiste nel repo: la funzione da citare è recoverAgentWords in " +
        "task-dispatcher.ts). (a) Auto-consegna: il gate di servizio " +
        "review_needs_summary RIFIUTA con 409 una review senza un commento fresco di " +
        "QUESTO turno — l'agente deve scrivere le sue parole. (b) Consegna di sistema: " +
        "se il turno muore prima della review, recoverAgentWords specchia l'ULTIMA " +
        "prosa della sessione DENTRO la nota di sistema (attribuzione onesta: mai " +
        "spacciata per un commento dell'agente) e il task va comunque in review. Solo " +
        "un task che non ha prodotto NIENTE — né commento fresco né parole in sessione " +
        "— viene parcheggiato come failed.",
      chat: "Non esiste il problema: l'ultimo messaggio È la consegna, si legge nel thread.",
      gesture: "0 — il testo arriva da solo sulla card; la review resta 1 click.",
      humanActionsBoard: 0,
      humanActionsChat: 0,
      verdict: "covered",
      subjects: [
        "server/services/task-dispatcher.ts",
        "server/services/tasks.ts",
      ],
    },
    [
      bunTest(
        "una consegna muta rimbalza con 409 review_needs_summary, e un commento la sblocca",
        "server/routes/tasks.test.ts",
        "review opens approval; agent → done is 409",
      ),
      bunTest(
        "le ultime parole dell'agente sono RECUPERATE nella nota di sistema quando il turno muore prima della review",
        "server/services/task-dispatcher.test.ts",
        "RECOVERS the agent's last words into the SYSTEM note",
      ),
      bunTest(
        "un task lavorato ma senza turni residui va all'umano in review, non a failed",
        "server/services/task-dispatcher.test.ts",
        "HANDS an exhausted-but-worked task to review",
      ),
      bunTest(
        "col commento fresco già lì non si specchia niente (nessun doppione)",
        "server/services/task-dispatcher.test.ts",
        "does NOT recover into the note when the agent already left a fresh comment",
      ),
      bunTest(
        "chi non ha prodotto NIENTE viene parcheggiato: la rete non inventa un lavoro",
        "server/services/task-dispatcher.test.ts",
        "still parks when the agent produced NOTHING",
      ),
      probe(
        "il nome citato nel brief non esiste: la funzione vera è recoverAgentWords",
        "grep ensureAgentSummary su server/ + client/",
        () => {
          const res = spawnSync(
            "grep",
            ["-rIl", "--include=*.ts", "--include=*.tsx", "ensureAgentSummary", "server", "client", "shared"],
            { cwd: ROOT, encoding: "utf8" },
          );
          const hits = (res.stdout ?? "").trim();
          must(hits === "", `ensureAgentSummary esiste dopotutto: ${hits}`);
          const disp = readFileSync(resolve(ROOT, "server/services/task-dispatcher.ts"), "utf8");
          must(disp.includes("function recoverAgentWords("), "recoverAgentWords non c'è più");
          must(disp.includes("deliverToReviewBySystem"), "la consegna di sistema non c'è più");
          return "0 occorrenze di ensureAgentSummary; recoverAgentWords + deliverToReviewBySystem presenti";
        },
      ),
      await boardProof(
        "censimento: quante consegne sono d'agente e quante di sistema (conta; rossa se le " +
          "colonne che distinguono le due strade spariscono dal payload)",
        (t) => {
          mustColumns(t, "deliveredBy", "dispatchState");
          const bySystem = t.filter((x) => x.deliveredBy === "system").length;
          const byAgent = t.filter((x) => x.deliveredBy === "agent").length;
          const failed = t.filter((x) => x.dispatchState === "failed").length;
          return `deliveredBy: agent=${byAgent}, system=${bySystem}; dispatchState=failed: ${failed}`;
        },
      ),
    ],
  );

  // ── 6. PLAN MODE E ATTESA UMANA ───────────────────────────────────────────
  if (want("6")) addCase(
    {
      id: "6",
      title: "Plan mode e turno in attesa di una persona",
      board:
        "Plan mode sulla board NON è il plan mode della CLI: è il flag planFirst del " +
        "task, che riscrive il kickoff («analizza, NON implementare, poi " +
        "comment_task(options=[Approva il piano, Da rivedere]) e vai in review»). Il " +
        "piano torna come una domanda normale sulla card, e l'approvazione è un click. " +
        "L'attesa umana vera (human-hold) resta un fatto di SESSIONE: copre domanda e " +
        "permesso con la stessa porta, ma con due orologi diversi — la domanda non " +
        "scade mai, il permesso vale come attesa solo entro 2h.",
      chat:
        "Plan mode vero: a fine turno shouldAskPlanApproval trasforma il piano nel pannello di approvazione, con l'opzione consigliata e l'avviso che l'autonomia cambia.",
      gesture: "1 click sull'opzione «Approva il piano» sulla card.",
      humanActionsBoard: 1,
      humanActionsChat: 1,
      verdict: "partial",
      subjects: [
        "server/lib/plan-approval.ts",
        "server/lib/human-hold.ts",
        "server/services/task-dispatcher.ts",
      ],
    },
    [
      bunTest(
        "il piano diventa una domanda normale: il pannello che c'è già la sa rendere",
        "server/lib/plan-approval.test.ts",
      ),
      bunTest(
        "il kickoff plan-first pretende il piano in review PRIMA di implementare",
        "server/services/task-dispatcher.test.ts",
        "plan-first kickoff demands a plan in review BEFORE implementing",
      ),
      bunTest(
        "human-hold: le due sorgenti sono lo stesso fatto, con due orologi diversi",
        "server/lib/human-hold.test.ts",
      ),
      probe(
        "la porta unica regge: domanda e permesso insieme, e l'esenzione si misura sulla PIÙ VECCHIA",
        "beginAsk + beginPermission → humanHoldAgeMs",
        () => {
          const sk = "topic:probe-hold";
          releaseHumanHold(sk, "reset probe");
          const t0 = Date.now();
          must(beginAsk(sk, 24 * 60 * 60 * 1000, t0 - 600_000), "apertura domanda fallita");
          must(beginPermission(sk, "tu-h", PERMISSION_TTL_MS, t0 - 60_000), "apertura permesso fallita");
          const age = humanHoldAgeMs(sk, t0);
          must(age !== null && age >= 590_000, `l'età deve essere quella della domanda (10min), non ${age}`);
          releaseHumanHold(sk, "probe");
          must(!isHumanHold(sk), "releaseHumanHold deve chiudere ENTRAMBE");
          must(humanHoldAgeMs(sk) === null, "nessuna attesa deve restare aperta");
          return `età = max(domanda 10min, permesso 1min) = ${Math.round((age ?? 0) / 60000)}min; releaseHumanHold chiude entrambe`;
        },
      ),
      sourceAssert(
        "il flag planFirst è ciò che riscrive il kickoff, e chiede opzioni cliccabili",
        "server/services/task-dispatcher.ts",
        { contains: ["task.planFirst", '"Approva il piano", "Da rivedere"'] },
      ),
      await boardProof(
        "censimento: quanti task sono stati messi in plan-first (conta; rossa se la colonna " +
          "planFirst sparisce dal payload)",
        (t) => {
          mustColumns(t, "planFirst");
          return `${t.filter((x) => x.planFirst).length} task con planFirst su ${t.length}`;
        },
      ),
    ],
  );

  // ── 7. TURNO LUNGO ────────────────────────────────────────────────────────
  if (want("7")) addCase(
    {
      id: "7",
      title: "Turno lungo: watchdog, autocompact, reaper d'inattività",
      board:
        "Gli stessi quattro orologi della chat, più due reti che esistono SOLO per il " +
        "dispatch. Gli orologi: watchdog del turno, tetto di vita del figlio, reaper " +
        "della pool fra un turno e l'altro, grazia sul rate-limit — tutti e quattro " +
        "chiedono a isHumanHold prima di mordere, e il reaper è quello che l'esenzione " +
        "l'ha presa per ultimo. L'autocompact non è silenzio sospetto: la dimensione " +
        "post-compaction si legge dalla PRIMA chiamata dopo il divisore, e un contesto " +
        "pieno si riprende sulla stessa sessione dicendolo (non è un fallimento). Le " +
        "due reti in più: il tetto di ritentativi (default 2, con backoff) e lo sweep " +
        "di liveness che seppellisce un run solo dopo DUE sonde morte consecutive — " +
        "«non lo so» non è «è morto».",
      chat:
        "Stessi orologi, nessuna rete di ripresa: un turno che muore lascia la chat com'è e tocca a te riscrivere.",
      gesture: "0 — nessuna: le reti sono automatiche.",
      humanActionsBoard: 0,
      humanActionsChat: 0,
      verdict: "covered",
      subjects: [
        "server/lib/turn-deadline.ts",
        "server/lib/human-hold.ts",
        "server/providers/claude-code.ts",
        "server/services/task-dispatcher.ts",
      ],
    },
    [
      bunTest(
        "watchdog: silenzio oltre la finestra uccide, ma una domanda in volo NON muore per quanto lungo sia il silenzio",
        "server/providers/turn-watchdog.test.ts",
      ),
      bunTest(
        "reaper d'inattività: mai durante un turno, riarmato dopo, mai su un processo morto",
        "server/providers/claude-code-inactivity.test.ts",
      ),
      bunTest(
        "autocompact: la dimensione del contesto si legge per chiamata, non sommando il turno",
        "server/providers/claude-code-context-size.test.ts",
      ),
      bunTest(
        "un figlio vivo ma muto durante un auto-compact non è un turno morto",
        "server/providers/claude-code-abort-exit.test.ts",
        "mute during auto-compact",
      ),
      bunTest(
        "il CONTESTO PIENO si riprende sulla stessa sessione e lo dice: non è un fallimento",
        "server/services/task-dispatcher.test.ts",
        "il CONTESTO PIENO si riprende e lo dice",
      ),
      bunTest(
        "una sessione VIVA ma muta non viene mai toccata (pensare a lungo non è morire)",
        "server/services/task-dispatcher.test.ts",
        "una sessione VIVA ma muta non viene mai toccata",
      ),
      bunTest(
        "un probe che non sa, o che lancia, non seppellisce niente (fail-safe)",
        "server/services/task-dispatcher.test.ts",
        "non è 'è morto'",
      ),
      probe(
        "il turno tenuto fermo da una persona è ESENTE da tutti gli orologi, tramite una porta sola",
        "isHumanHold nei siti di armamento (claude-code.ts)",
        () => {
          const src = readFileSync(resolve(ROOT, "server/providers/claude-code.ts"), "utf8");
          const sites = (src.match(/isHumanHold\(/g) ?? []).length;
          must(sites >= 4, `attesi ≥4 punti che interrogano isHumanHold, trovati ${sites}`);
          must(
            src.includes("isWaitingForHuman: () => isHumanHold(sessionKey)"),
            "il deadline del turno non passa più da isHumanHold",
          );
          must(
            src.includes("if (isHumanHold(key)) { this.resetInactivityTimer(key, pp, opts); return; }"),
            "il reaper d'inattività ha perso l'esenzione (era l'unico dei quattro a non averla)",
          );
          const sk = "topic:probe-clock";
          releaseHumanHold(sk, "reset probe");
          must(!isHumanHold(sk), "partenza sporca");
          must(beginAsk(sk), "apertura domanda fallita");
          must(isHumanHold(sk), "l'esenzione non si attiva");
          cancelAsk(sk, "probe");
          return `${sites} punti interrogano isHumanHold; deadline + reaper entrambi coperti`;
        },
      ),
      await boardProof(
        "censimento: quanti task hanno consumato più di un turno (conta; rossa se la colonna " +
          "dispatchAttempts sparisce dal payload)",
        (t) => {
          mustColumns(t, "dispatchAttempts");
          const many = t.filter((x) => (x.dispatchAttempts ?? 0) > 1);
          return `${many.length} task con dispatchAttempts > 1 su ${t.length} (turni ripresi dopo un'interruzione)`;
        },
      ),
    ],
  );

  // ── 8. RELOAD DEL SERVER DURANTE UN TURNO DISPATCHATO ─────────────────────
  if (want("8")) addCase(
    {
      id: "8",
      title: "Reload del server durante un turno dispatchato",
      board:
        "È il caso in cui la board vince di netto. Prima del reload c'è un CANCELLO " +
        "(scripts/server-reload-gate.sh, ~30ms): se l'albero dei moduli non si risolve " +
        "il giro si salta e il server vecchio resta su. Dopo il reload, reconcile " +
        "ricuce i task orfani con quattro strade distinte: se una sessione del broker è " +
        "sopravvissuta si RIATTACCA in place; se il topic è vivo ma la sessione no si " +
        "RIPRENDE su quella sessione (senza bruciare un tentativo); se il topic è morto " +
        "si ri-dispaccia da capo; con l'interruttore globale spento si rimette in coda " +
        "senza chip appesi. E il giro è idempotente sotto il poll: un turno ripreso non " +
        "si sdoppia.",
      chat:
        "La chat non ha reconcile: al reload il turno in volo si perde e il messaggio resta senza risposta — è chi lo riscrive a rimetterlo in piedi.",
      gesture: "0 — la ricucitura è automatica.",
      humanActionsBoard: 0,
      humanActionsChat: 1,
      verdict: "covered",
      subjects: [
        "server/services/task-dispatcher.ts",
        "server/providers/claude-code.ts",
      ],
    },
    [
      bunTest(
        "un riavvio NON è un fallimento: l'orfano si rimette sempre in coda, il tentativo si rimborsa",
        "server/services/task-dispatcher.test.ts",
        "ALWAYS requeues a restart orphan",
      ),
      bunTest(
        "l'orfano che stava lavorando RIPRENDE sulla sua sessione, senza requeue e senza bruciare un tentativo",
        "server/services/task-dispatcher.test.ts",
        "RESUMES a working restart-orphan on its own session",
      ),
      bunTest(
        "se una sessione del broker è sopravvissuta al riavvio, si RIATTACCA in place",
        "server/services/task-dispatcher.test.ts",
        "REATTACHES in place",
      ),
      bunTest(
        "sotto il poll il giro è idempotente: un turno ripreso non viene doppiato",
        "server/services/task-dispatcher.test.ts",
        "reconcile is idempotent under the poll",
      ),
      bunTest(
        "se il topic è morto durante il buio, si ri-dispaccia da capo",
        "server/services/task-dispatcher.test.ts",
        "whose topic died during the downtime",
      ),
      probe(
        "il cancello del reload esiste, è eseguibile e ADESSO dice verde sull'albero di HEAD",
        "scripts/server-reload-gate.sh (eseguito)",
        () => {
          const gate = resolve(ROOT, "scripts/server-reload-gate.sh");
          must(existsSync(gate), "scripts/server-reload-gate.sh non esiste");
          const t0 = Date.now();
          const res = spawnSync(gate, [ROOT], { cwd: ROOT, encoding: "utf8" });
          const ms = Date.now() - t0;
          const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(0, 200);
          must(res.status === 0, `il cancello è ROSSO su HEAD (exit ${res.status}): ${out}`);
          return `exit 0 in ${ms}ms${out ? ` — ${out}` : ""}`;
        },
      ),
      sourceAssert(
        "il watcher di produzione passa dal cancello prima di segare il server che sta lavorando",
        "scripts/start-prod.sh",
        { before: ["scripts/server-reload-gate.sh", 'kill -TERM "$SP"'] },
      ),
    ],
  );

  // ── 9. COSA NON SI PUÒ FARE DALLA BOARD ───────────────────────────────────
  if (want("9")) addCase(
    {
      id: "9",
      title: "Cosa NON si può fare dalla board (e in chat sì)",
      board:
        "L'elenco onesto, in ordine di quanto costa: " +
        "(a) DECIDERE UN PERMESSO — la card non lo mostra e non lo sa: serve aprire il " +
        "tab (caso 2). " +
        "(b) RISPONDERE A UN PANNELLO ask_user_question aperto a metà turno — stessa " +
        "storia, la card resta 'working' (caso 1b). " +
        "(c) FERMARE senza distruggere — POST /stop parcheggia il task in backlog, lo " +
        "SLEGA dal topic e non lo rimette in coda; in chat un ESC interrompe il turno e " +
        "la sessione resta dov'è, pronta a ripartire. " +
        "(d) INTERVENIRE SUBITO a turno vivo — un commento è bufferato fino al confine " +
        "del turno; nella chat della sessione si scrive e basta. " +
        "(e) ORCHESTRARE — sotto-agenti (spawn/send/read/stop_agent), chat cross-topic, " +
        "navigazione topic/progetto e import dei cookie di Chrome sono TOLTI al profilo " +
        "dispatch: un agente di board non può fare fan-out né cambiare stanza. " +
        "(f) CAMBIARE MODELLO O EFFORT a metà lavoro — si scelgono al dispatch e " +
        "restano; nella chat il picker è lì. " +
        "(g) I COMANDI SLASH e gli allegati arbitrari: sulla board un allegato deve " +
        "stare sotto ~/.topics/media/ o nel workspace, o il commento viene rifiutato.",
      chat: "Tutto quanto sopra è a portata di composer, nello stesso posto in cui si legge.",
      gesture: "Il costo del buco è +1 gesto di navigazione (aprire il tab) sui casi (a) e (b).",
      humanActionsBoard: 2,
      humanActionsChat: 1,
      verdict: "gap",
      subjects: [
        "server/mcp/topics-mcp-server.ts",
        "server/routes/tasks.ts",
      ],
    },
    [
      probe(
        "(e) il profilo dispatch TOGLIE davvero l'orchestrazione: elenco misurato, non dedotto",
        "toolsForProfile('dispatch') vs toolsForProfile(undefined)",
        () => {
          const full = toolsForProfile(undefined).map((t) => t.name);
          const disp = new Set(toolsForProfile("dispatch").map((t) => t.name));
          const removed = full.filter((n) => !disp.has(n)).sort();
          const expected = [
            "create_project",
            "import_chrome",
            "list_agents",
            "move_session_to_project",
            "new_topic",
            "open_project",
            "read_agent",
            "read_chat_messages",
            "send_chat_message",
            "send_to_agent",
            "spawn_agent",
            "stop_agent",
            "switch_topic",
          ];
          for (const name of expected) {
            must(removed.includes(name), `atteso tolto al profilo dispatch, ma c'è ancora: ${name}`);
            must(
              !isToolAllowedForProfile("dispatch", name),
              `${name} è ancora CHIAMABILE nel profilo dispatch (difesa in profondità saltata)`,
            );
          }
          must(disp.has("comment_task") && disp.has("update_task"), "i tool di task devono restare");
          return `tolti ${removed.length}: ${removed.join(", ")}`;
        },
      ),
      bunTest(
        "(c) POST /stop parcheggia in backlog e ABORTA il turno: non è una pausa, non c'è auto-requeue",
        "server/routes/tasks.test.ts",
        "POST stop parks the task",
      ),
      bunTest(
        "(d) a turno vivo il commento NON entra subito: è bufferato fino al confine del turno",
        "server/services/task-dispatcher.test.ts",
        "buffers a resume landing while the turn is in flight",
      ),
      bunTest(
        "(g) un allegato fuori dall'allowlist è SCARTATO in scrittura, non solo nascosto",
        "server/routes/tasks.test.ts",
        "media outside the /api/media allowlist is DROPPED",
      ),
      sourceAbsentIn(
        "(a)+(b) NEGATIVO su tutta la superficie board: né permessi né pannelli di domanda in-chat",
        BOARD_SURFACE,
        ["permissionRequest", "awaiting_permission", "pendingAsk", "userInputRequest"],
      ),
      sourceAbsentIn(
        "(f) NEGATIVO: la card non ha un selettore di modello/effort — sono decisi al dispatch",
        ["client/src/components/Board/Card.tsx"],
        ["ProviderModelPicker", "setModel(", "onChangeEffort"],
      ),
      sourceAssert(
        "(f) modello ed effort si scelgono al dispatch e viaggiano nel topic dell'agente",
        "server/services/task-dispatcher.ts",
        { contains: ["task.model", "effort"] },
      ),
    ],
  );

  // ── 10. COSA SI PUÒ DALLA BOARD E NON IN CHAT ─────────────────────────────
  if (want("10")) addCase(
    {
      id: "10",
      title: "Cosa si può dalla board e NON in chat",
      board:
        "(a) WORKTREE ISOLATO — ogni task lavora in un albero suo; se il worktree serve " +
        "e non c'è, il task viene PARCHEGGIATO invece di andare a scrivere nella " +
        "working tree condivisa. " +
        "(b) PARALLELISMO GOVERNATO — un tetto di concorrenza unico per macchina e una " +
        "coda servita per priorità (4 prima, età come spareggio). " +
        "(c) STORICO E CONSUMO PER TASK — agent_ms, agent_tokens e " +
        "agent_cache_read_tokens restano scritti sulla riga del task: dopo, si può " +
        "chiedere quanto è costato QUEL lavoro. In chat non c'è la riga a cui " +
        "attaccarlo. " +
        "(d) ANTEPRIMA DURATURA — previewImage (screenshot o VIDEO) resta sulla card " +
        "quando la sessione è morta da un pezzo; l'output_url del dev server " +
        "dell'agente no, è effimero e il kickoff lo dice. " +
        "(e) CHECKS PRE-REVIEW automatici nel worktree del task: rossi → la consegna " +
        "viene rifiutata con l'output. " +
        "(f) LAND LOCALE come scelta di un'opzione: il merge su main lo fa il sistema, " +
        "l'agente non fa mai git merge/push.",
      chat: "Una chat non ha un worktree suo, non ha una coda, non lascia un consuntivo e non conserva un'anteprima.",
      gesture: "1 click per «Landa su main»; 0 per tutto il resto (è automatico).",
      humanActionsBoard: 1,
      humanActionsChat: -1,
      verdict: "covered",
      subjects: [
        "server/services/task-dispatcher.ts",
        "server/services/transcript-usage.ts",
      ],
    },
    [
      bunTest(
        "(a) se il worktree serve e non c'è, il task viene PARCHEGGIATO (non gira in place)",
        "server/services/task-dispatcher.test.ts",
        "when a worktree is required but unavailable",
      ),
      bunTest(
        "(a) e in place ci gira solo se la board lo ha scelto",
        "server/services/task-dispatcher.test.ts",
        "when the board opts out",
      ),
      bunTest(
        "(b) il tetto di concorrenza è rispettato",
        "server/services/task-dispatcher.test.ts",
        "respects the concurrency cap",
      ),
      bunTest(
        "(b) la coda serve prima le priorità alte, età come spareggio",
        "server/services/task-dispatcher.test.ts",
        "serves the queue by priority",
      ),
      bunTest(
        "(c) ogni fine turno scrive sul task il DELTA di orologio e di consumo (billable e cache-read SEPARATI)",
        "server/services/task-dispatcher.test.ts",
        "books wall-clock",
      ),
      bunTest(
        "(e) checks rossi → 409 con l'OUTPUT del comando, e il task NON entra in review",
        "server/routes/tasks.test.ts",
        "409 con L'OUTPUT del comando",
      ),
      bunTest(
        "(f) scegliere «Landa su main» approva e fa il merge: non è un reject/resume",
        "server/routes/tasks.test.ts",
        "Landa su main",
      ),
      probe(
        "(c) le due colonne del consumo esistono e sono SEPARATE, con la data che le rende comparabili",
        "migration 048 + colonne sul task",
        () => {
          const mig = resolve(ROOT, "server/db/migrations/048-task-agent-cache-read.sql");
          must(existsSync(mig), "la migration 048 non esiste");
          const sql = readFileSync(mig, "utf8");
          must(sql.includes("agent_cache_read_tokens"), "la colonna cache-read non è quella");
          must(sql.includes("NOT comparable"), "la migration non dichiara più l'incomparabilità dei valori vecchi");
          const { at, source } = migration048At();
          must(at !== null, `soglia 048 non determinabile (${source}): senza di lei non si può dire cosa è comparabile`);
          return (
            `agent_cache_read_tokens separata da agent_tokens; soglia applicata ${new Date(at!).toISOString()} ` +
            `(${source}); i valori PRIMA sono gonfiati ~2,4×`
          );
        },
      ),
      await boardProof(
        "censimento: (c)+(d) quanto storico esiste. Conteggio grezzo sul payload della board " +
          "(denominatore = task con agentTokens>0), non l'aritmetica dei token: quella è di " +
          "scripts/board-vs-chat.ts, che legge il transcript. Qui serve solo a dire che la riga " +
          "esiste; è rossa se le colonne dei token spariscono dal payload.",
        (t) => {
          mustColumns(t, "agentTokens", "agentCacheReadTokens", "previewImage", "completedAt", "updatedAt");
          const { at, source } = migration048At();
          const withTokens = t.filter((x) => (x.agentTokens ?? 0) > 0);
          const noCacheRead = withTokens.filter((x) => (x.agentCacheReadTokens ?? 0) === 0);
          const withPreview = t.filter((x) => x.previewImage).length;
          // Senza la soglia non si dichiara «comparabile»: si dice che non si sa.
          const split =
            at === null
              ? `comparabilità NON determinabile (${source})`
              : (() => {
                  const post = withTokens.filter((x) => Date.parse(comparableStamp(x)) >= at).length;
                  return `${post} post-048 (comparabili), ${withTokens.length - post} pre-048 (gonfiati ~2,4×, da escludere)`;
                })();
          return (
            `${withTokens.length}/${t.length} task con agentTokens>0; ${split}; ` +
            `${noCacheRead.length} senza cache-read registrato; ${withPreview} con previewImage`
          );
        },
      ),
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Uscita
// ─────────────────────────────────────────────────────────────────────────────

export interface CasesReport {
  section: "casi-limite";
  generatedAt: string;
  /** Un gesto discreto: un click, oppure un invio di testo. */
  humanActionDefinition: string;
  /** La barra dichiarata: ≤2 azioni umane per ciclo di feedback. */
  humanActionBar: number;
  cases: CaseRow[];
  proofs: Proof[];
  totals: {
    cases: number;
    covered: number;
    partial: number;
    gap: number;
    proofsRun: number;
    proofsPassed: number;
    proofsFailed: number;
    proofsSkipped: number;
    casesWithoutExecutedProof: string[];
    casesOverActionBar: string[];
  };
  ok: boolean;
}

function report(): CasesReport {
  const executed = proofs.filter((p) => p.status !== "skipped");
  const failed = proofs.filter((p) => p.status === "fail");
  const withoutExecuted = cases
    .filter((c) => !c.proofIdx.some((i) => proofs[i]!.status !== "skipped"))
    .map((c) => c.id);
  // La barra vale sui cicli di feedback REALI: un caso che non è un ciclo
  // (humanActionsBoard = 0 o -1 «non esiste in chat») non ha una barra da
  // superare — contarlo sarebbe un'asserzione che non può fallire.
  const overBar = cases.filter((c) => c.humanActionsBoard > 2).map((c) => c.id);
  return {
    section: "casi-limite",
    generatedAt: new Date().toISOString(),
    humanActionDefinition:
      "un gesto discreto e indivisibile: un click, oppure un invio di testo (digitare + Invio = 1). " +
      "Leggere e scorrere non contano; i gesti di NAVIGAZIONE necessari a raggiungere il controllo sì.",
    humanActionBar: 2,
    cases,
    proofs,
    totals: {
      cases: cases.length,
      covered: cases.filter((c) => c.verdict === "covered").length,
      partial: cases.filter((c) => c.verdict === "partial").length,
      gap: cases.filter((c) => c.verdict === "gap").length,
      proofsRun: executed.length,
      proofsPassed: proofs.filter((p) => p.status === "pass").length,
      proofsFailed: failed.length,
      proofsSkipped: proofs.filter((p) => p.status === "skipped").length,
      casesWithoutExecutedProof: withoutExecuted,
      casesOverActionBar: overBar,
    },
    ok: failed.length === 0 && withoutExecuted.length === 0 && overBar.length === 0,
  };
}

/** Il punto d'aggancio per chi compone il report. `only` = un caso solo. */
export async function runSection(only?: string): Promise<CasesReport> {
  if (cases.length === 0) await build(only);
  return report();
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggancio a scripts/board-vs-chat.ts
//
// La barra composta NON importa questo modulo: legge `docs/board-vs-chat/cases.json`
// (schemaVersion 1). Quindi qui si EMETTE quel file, e la prova che ci finisce
// dentro è un comando corto che chiunque può rieseguire — `bun
// scripts/board-cases.ts --case <id>` — con l'exit code OSSERVATO facendolo
// girare davvero, non dedotto.
//
// Il vocabolario è diverso e la traduzione va dichiarata, non nascosta:
// il loro `uncovered` significa «sulla board questo caso NON ha strada», e non
// è il mio `gap`. Un permesso una strada ce l'ha — passa dal tab dell'agente e
// costa un gesto in più — quindi diventa `workaround`, con la nota che dice
// esattamente cosa manca. Chiamarlo `uncovered` sarebbe più drammatico e meno
// vero; chiamarlo `covered` sarebbe una bugia.
// ─────────────────────────────────────────────────────────────────────────────

const CASES_JSON = "docs/board-vs-chat/cases.json";

export function coverageFor(v: Verdict): "covered" | "workaround" | "uncovered" {
  return v === "covered" ? "covered" : "workaround";
}

async function emitCasesFile(path: string): Promise<number> {
  const full = await runSection();
  const out: {
    schemaVersion: 1;
    generatedBy: string;
    generatedAt: string;
    humanActionDefinition: string;
    fingerprint: MatrixFingerprint;
    cases: Array<{
      id: string;
      title: string;
      coverage: string;
      humanActions: number;
      note: string;
      proof: { kind: "command"; cmd: string; exitCode: number; expectExit: number; output: string };
    }>;
  } = {
    schemaVersion: 1,
    generatedBy: "scripts/board-cases.ts --emit-cases",
    generatedAt: new Date().toISOString(),
    humanActionDefinition: full.humanActionDefinition,
    // Riempita in fondo: l'insieme dei file letti si conosce solo dopo che tutte
    // le prove hanno girato.
    fingerprint: { algo: "sha256", files: {} },
    cases: [],
  };

  for (const c of full.cases) {
    const cmd = `bun scripts/board-cases.ts --case ${c.id}`;
    const res = spawnSync("bun", ["scripts/board-cases.ts", "--case", c.id, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const exitCode = res.status ?? 1;
    const rowProofs = c.proofIdx.map((i) => proofs[i]!);
    const executed = rowProofs.filter((p) => p.status !== "skipped");
    // L'output incollato è l'ESITO di ogni prova della riga, una per riga: chi
    // legge il file deve poter vedere cosa è stato eseguito senza rilanciarlo.
    const output = [
      `${executed.length} prove eseguite (${executed.filter((p) => p.status === "pass").length} verdi, ` +
        `${executed.filter((p) => p.status === "fail").length} rosse), ` +
        `${rowProofs.length - executed.length} saltate`,
      ...rowProofs.map((p) => `${icon(p.status)} [${p.kind}] ${p.claim} — ${p.command} → ${p.detail}`),
    ].join("\n");

    out.cases.push({
      id: c.id,
      title: c.title,
      coverage: coverageFor(c.verdict),
      humanActions: c.humanActionsBoard,
      note:
        `verdetto della matrice: ${c.verdict}` +
        (c.verdict === "covered"
          ? ""
          : " → 'workaround' nello schema di board-vs-chat: una strada esiste, ma non sulla superficie della board") +
        `. GESTO: ${c.gesture} BOARD: ${c.board} CHAT: ${c.chat}`,
      proof: { kind: "command", cmd, exitCode, expectExit: 0, output },
    });
  }

  // L'impronta ha TRE sorgenti, e la terza è quella che mancava:
  //   1. questo file, che le prove le scrive;
  //   2. ogni sorgente che una prova ha davvero letto (`proof.files`);
  //   3. i moduli che le righe DICHIARANO come soggetto (`case.subjects`) —
  //      senza i quali una prova in-process, che non porta file con sé, lascia
  //      il proprio soggetto fuori dalla rete.
  out.fingerprint = fingerprintFiles(
    [
      "scripts/board-cases.ts",
      ...proofs.flatMap((p) => p.files ?? []),
      ...cases.flatMap((c) => c.subjects),
    ],
    ROOT,
  );

  const abs = resolve(ROOT, path);
  writeFileSync(abs, `${JSON.stringify(out, null, 2)}\n`);
  const bad = out.cases.filter((c) => c.proof.exitCode !== 0).map((c) => c.id);
  console.log(
    `scritto ${path}: ${out.cases.length} casi, impronta su ${Object.keys(out.fingerprint.files).length} file.`,
  );
  if (bad.length) {
    console.error(`✗ casi la cui prova ricopiabile è ROSSA: ${bad.join(", ")}`);
    return 1;
  }
  return full.ok ? 0 : 1;
}

function icon(s: ProofStatus): string {
  return s === "pass" ? "✓" : s === "fail" ? "✗" : "–";
}

function printHuman(r: CasesReport): void {
  console.log("\n═══ MATRICE DEI CASI LIMITE — board vs chat ═══\n");
  console.log(`Azione umana = ${r.humanActionDefinition}`);
  console.log(`Barra: ≤${r.humanActionBar} azioni per ciclo di feedback.\n`);
  for (const c of r.cases) {
    const mark = c.verdict === "covered" ? "●" : c.verdict === "partial" ? "◐" : "○";
    console.log(`${mark} [${c.id}] ${c.title}  — ${c.verdict.toUpperCase()}`);
    console.log(`   BOARD : ${c.board}`);
    console.log(`   CHAT  : ${c.chat}`);
    console.log(`   GESTO : ${c.gesture}`);
    const chatCost = c.humanActionsChat < 0 ? "n/d (non esiste in chat)" : `${c.humanActionsChat}`;
    console.log(`   AZIONI: board ${c.humanActionsBoard} · chat ${chatCost}`);
    for (const i of c.proofIdx) {
      const p = proofs[i]!;
      console.log(`   ${icon(p.status)} [${p.kind}] ${p.claim}`);
      console.log(`       $ ${p.command}`);
      console.log(`       → ${p.detail}`);
    }
    console.log("");
  }
  const t = r.totals;
  console.log(
    `Casi: ${t.cases} (${t.covered} coperti, ${t.partial} parziali, ${t.gap} buchi). ` +
      `Prove: ${t.proofsRun} eseguite (${t.proofsPassed} verdi, ${t.proofsFailed} rosse), ${t.proofsSkipped} saltate.`,
  );
  if (t.casesWithoutExecutedProof.length) {
    console.error(`✗ casi senza NESSUNA prova eseguita: ${t.casesWithoutExecutedProof.join(", ")}`);
  }
  if (t.casesOverActionBar.length) {
    console.error(`✗ casi oltre la barra di ${r.humanActionBar} azioni: ${t.casesOverActionBar.join(", ")}`);
  }
  console.log(r.ok ? "\n✓ matrice verde\n" : "\n✗ matrice ROSSA\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const emitIdx = argv.indexOf("--emit-cases");
  if (emitIdx >= 0) {
    const target = argv[emitIdx + 1] && !argv[emitIdx + 1]!.startsWith("--") ? argv[emitIdx + 1]! : CASES_JSON;
    process.exit(await emitCasesFile(target));
  }
  const caseIdx = argv.indexOf("--case");
  const only = caseIdx >= 0 ? argv[caseIdx + 1] : undefined;
  if (only !== undefined && !(CASE_IDS as readonly string[]).includes(only)) {
    console.error(`✗ caso sconosciuto: ${only} (validi: ${CASE_IDS.join(", ")})`);
    process.exit(2);
  }
  const r = await runSection(only);
  if (r.cases.length === 0) {
    console.error("✗ nessun caso costruito");
    process.exit(2);
  }
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else printHuman(r);
  process.exit(r.ok ? 0 : 1);
}
