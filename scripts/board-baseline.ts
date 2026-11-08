#!/usr/bin/env bun
/**
 * board-baseline — quanto è costato, DAVVERO, il lavoro già fatto: sulla board
 * (agente dispatchato in worktree) e in chat (sessione Topics normale).
 *
 * ── Cosa risponde ────────────────────────────────────────────────────────────
 * È la BASELINE STORICA del confronto "board vs chat": non misura niente di
 * nuovo, legge il corpus che esiste già e lo mette in forma comparabile. Serve
 * a dare un ordine di grandezza prima di spendere token in un A/B dal vivo, e a
 * dire con onestà quale parte del confronto il corpus storico NON può reggere.
 *
 * ── Da dove vengono i numeri (una sola verità) ───────────────────────────────
 * Lato board: `tasks.agent_tokens` + `tasks.agent_cache_read_tokens`. NON sono
 * un secondo conto: il dispatcher li scrive leggendo la stessa
 * `createTranscriptUsageReader()` di questo file
 * (`task-dispatcher.ts:recordUsage` → `svc.recordAgentUsage`), quindi la board
 * è già "il reader, accumulato per turno".
 * Lato chat: `createTranscriptUsageReader()` sul JSONL della sessione, cioè
 * esattamente ciò che fa `scripts/token-live.ts`.
 * Dollari: `calculateCostWithCache` di `server/usage/pricing.ts`.
 *
 * ── Le due grandezze non si sommano MAI in silenzio ──────────────────────────
 * `work` = input + output + cache_creation (il chip della card, la semantica
 * storica di `agent_tokens`). `cacheRead` = la rilettura del contesto, che è la
 * quota dominante del consumo reale. Stanno in due campi separati in ogni punto
 * dell'output; dove serve un totale si chiama `readTotal` ed è esplicito.
 *
 * ── La circolarità, e come è evitata ─────────────────────────────────────────
 * Classificare la "taglia" di un task guardando i token e poi misurare i token
 * per taglia non dimostra niente. Qui la classe si decide su segnali che il
 * conto dei token non tocca:
 *   · `files`    — file toccati dal commit di consegna (`tasks.delivery_commit`,
 *                  `git show --numstat`). È una proprietà dell'ARTEFATTO, non
 *                  del processo: il classificatore più forte dei tre.
 *   · `duration` — `tasks.agent_ms`, tempo di ESECUZIONE sommato per turno (le
 *                  pause fra un turno e l'altro non entrano, cfr. il commento
 *                  su `startLiveTurn`).
 *   · `turns`    — messaggi `role='user'` del topic dell'agente.
 * Le soglie sono FISSE e dichiarate a priori (vedi `THRESHOLDS`), non terzili
 * ricavati dal campione: un terzile produce sempre tre gruppi pieni, cioè una
 * classificazione che non può fallire.
 * `duration` e `turns` restano segnali di PROCESSO e quindi correlano con il
 * costo quasi per costruzione (ogni turno rilegge il contesto): l'output riporta
 * la matrice di accordo fra i tre così che la correlazione si veda invece di
 * essere assunta.
 *
 * ── Cosa il corpus storico NON può dire ──────────────────────────────────────
 * Il confronto board↔chat qui dentro NON è appaiato: sono lavori diversi, fatti
 * in momenti diversi, da modelli diversi. Peggio: `files` esiste solo lato
 * board (una chat lavora sull'albero principale e non lascia un
 * `delivery_commit`), quindi le due distribuzioni non sono nemmeno normalizzate
 * per taglia del lavoro. Ogni statistica di confronto esce marcata
 * `paired:false` e con l'intervallo di incertezza; il numero che DECIDE deve
 * venire da un A/B dal vivo, non da qui.
 *
 *   bun scripts/board-baseline.ts            # tabella leggibile
 *   bun scripts/board-baseline.ts --json     # il JSON di riferimento
 *   bun scripts/board-baseline.ts --out FILE # scrive il JSON e stampa la tabella
 *   bun scripts/board-baseline.ts --project topics-app-ar3jt5
 *
 * Sola lettura: il DB si apre `{ readonly: true }` e git si interroga con
 * `show --numstat`. Non tocca il server, non tocca l'albero di lavoro.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTranscriptUsageReader, type SessionUsage } from "../server/services/transcript-usage";
import { calculateCostWithCache } from "../server/usage/pricing";

// ── Parametri dichiarati ─────────────────────────────────────────────────────

export const DEFAULT_PROJECT_ID = "topics-app-ar3jt5";

/** Soglie fisse, scelte prima di guardare i token. Vedi l'intestazione. */
export const THRESHOLDS = {
  /** File toccati dal commit di consegna. */
  files: { smallMax: 2, mediumMax: 9 },
  /** Millisecondi di esecuzione sommati per turno. */
  durationMs: { smallMax: 5 * 60_000, mediumMax: 30 * 60_000 },
  /** Messaggi umani (role='user') nel topic. */
  turns: { smallMax: 2, mediumMax: 8 },
} as const;

/** Una chat resta "la stessa seduta" finché non tace più di così. */
const EPISODE_GAP_MS = 30 * 60_000;

/** Numero di ricampionamenti bootstrap per gli intervalli. Seed fisso: deterministico. */
const BOOTSTRAP_N = 2000;
const BOOTSTRAP_SEED = 20260809;

export type SizeClass = "small" | "medium" | "large";
const CLASSES: readonly SizeClass[] = ["small", "medium", "large"] as const;

/**
 * Quale timestamp decide se un task è post-048.
 *
 * `start` — `in_progress_at`: un task PARTITO prima della 048 ha accumulato
 *   turni con il conto vecchio, e finirli dopo non li ripulisce. È la regola
 *   giusta, ed è il default.
 * `end` — `completed_at ?? updated_at`: la regola SBAGLIATA, tenuta viva solo
 *   per poter mostrare con un comando cosa fa entrare (vedi `integrity`).
 *   `scripts/board-vs-chat.ts` NON ce l'ha più: importa il predicato qui sotto
 *   in modalità `start`, così le due soglie non possono più divergere.
 */
export type CutoffMode = "start" | "end";

/**
 * I soli campi che decidono la comparabilità. Volutamente in `snake_case`: sono
 * le colonne di `tasks` così come escono dalla query, e chi le rinomina scopre
 * subito che sta guardando un'altra riga.
 */
export interface CutoffFields {
  in_progress_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
}

/** Il timbro su cui si taglia, secondo la modalità. `null` = non databile. */
export function comparabilityStamp(row: CutoffFields, mode: CutoffMode = "start"): string | null {
  const stamp = mode === "start"
    ? (row.in_progress_at ?? row.completed_at ?? null)
    : (row.completed_at ?? row.updated_at ?? null);
  return typeof stamp === "string" && stamp.length > 0 ? stamp : null;
}

/**
 * UNICA definizione di «questa riga di `tasks` è confrontabile».
 *
 * Un task PARTITO prima della migration 048 ha `agent_tokens` gonfiati ~2,4×
 * (una riga di usage per content-block, non deduplicata) e
 * `agent_cache_read_tokens` a zero perché la colonna non esisteva. Chiuderlo
 * dopo non lo ripulisce, quindi si taglia sull'INIZIO. Senza soglia nota non è
 * comparabile NIENTE: nel dubbio si esclude.
 */
export function isComparablePost048(
  row: CutoffFields,
  migration048At: string | null,
  mode: CutoffMode = "start",
): boolean {
  if (!migration048At) return false;
  const stamp = comparabilityStamp(row, mode);
  return stamp !== null && stamp >= migration048At;
}

// ── Statistica ───────────────────────────────────────────────────────────────

export interface Stats {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  mean: number;
  /** Scarto interquartile: la dispersione robusta, quella che si legge. */
  iqr: number;
  /** Intervallo di incertezza sulla MEDIANA, bootstrap percentile al 95%. */
  medianCi95: [number, number] | null;
}

/** Quantile con interpolazione lineare (tipo 7, quello di R e numpy). */
function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (h - lo);
}

/** LCG a seme fisso: il bootstrap deve dare lo stesso intervallo a ogni giro. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function medianOf(sorted: readonly number[]): number {
  return quantile(sorted, 0.5);
}

function bootstrapMedianCi(values: readonly number[], seed: number): [number, number] | null {
  // Sotto gli 8 punti un intervallo bootstrap è teatro: meglio dire "non lo so".
  if (values.length < 8) return null;
  const rng = makeRng(seed);
  const meds: number[] = [];
  const buf = new Array<number>(values.length);
  for (let b = 0; b < BOOTSTRAP_N; b++) {
    for (let i = 0; i < values.length; i++) buf[i] = values[Math.floor(rng() * values.length)] ?? 0;
    const s = [...buf].sort((x, y) => x - y);
    meds.push(medianOf(s));
  }
  meds.sort((x, y) => x - y);
  return [quantile(meds, 0.025), quantile(meds, 0.975)];
}

export function stats(values: readonly number[], seed = BOOTSTRAP_SEED): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0, iqr: 0, medianCi95: null };
  }
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  return {
    n,
    min: sorted[0] ?? 0,
    p25,
    median: medianOf(sorted),
    p75,
    max: sorted[n - 1] ?? 0,
    mean: sorted.reduce((a, b) => a + b, 0) / n,
    iqr: p75 - p25,
    medianCi95: bootstrapMedianCi(sorted, seed),
  };
}

export interface CliffsDelta {
  /** −1 = il secondo campione domina, +1 = il primo, 0 = si sovrappongono. */
  delta: number;
  ci95: [number, number] | null;
  nA: number;
  nB: number;
  /** Vero solo se l'intervallo NON contiene lo zero. */
  separates: boolean;
}

/** Effetto ordinale fra due campioni NON appaiati. Nessuna ipotesi di normalità. */
export function cliffsDelta(a: readonly number[], b: readonly number[], seed = BOOTSTRAP_SEED): CliffsDelta {
  const raw = (xs: readonly number[], ys: readonly number[]): number => {
    if (xs.length === 0 || ys.length === 0) return 0;
    let gt = 0;
    let lt = 0;
    for (const x of xs) for (const y of ys) { if (x > y) gt++; else if (x < y) lt++; }
    return (gt - lt) / (xs.length * ys.length);
  };
  const delta = raw(a, b);
  let ci: [number, number] | null = null;
  if (a.length >= 8 && b.length >= 8) {
    const rng = makeRng(seed ^ 0x5f5f);
    const ds: number[] = [];
    for (let i = 0; i < 400; i++) {
      const ra = a.map(() => a[Math.floor(rng() * a.length)] ?? 0);
      const rb = b.map(() => b[Math.floor(rng() * b.length)] ?? 0);
      ds.push(raw(ra, rb));
    }
    ds.sort((x, y) => x - y);
    ci = [quantile(ds, 0.025), quantile(ds, 0.975)];
  }
  return { delta, ci95: ci, nA: a.length, nB: b.length, separates: ci ? ci[0] > 0 || ci[1] < 0 : false };
}

// ── Classificazione (mai sui token) ──────────────────────────────────────────

function classifyBy(value: number | null, smallMax: number, mediumMax: number): SizeClass | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value <= smallMax) return "small";
  if (value <= mediumMax) return "medium";
  return "large";
}

// ── Lettura del DB ───────────────────────────────────────────────────────────

function dbPath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "topics.db")
    : join(import.meta.dir, "..", "data", "topics.db");
}

interface TaskRow {
  id: string;
  text: string;
  status: string;
  archived: number;
  in_progress_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_ms: number;
  agent_tokens: number;
  agent_cache_read_tokens: number;
  model: string | null;
  delivery_commit: string | null;
  assigned_topic_id: string | null;
  session_key: string | null;
  jsonl_path: string | null;
}

interface TopicRow {
  id: string;
  name: string;
  project_path: string | null;
  session_key: string;
  jsonl_path: string;
  created_at: string;
  updated_at: string;
  board_bound: number;
  worktree_id: string | null;
}

/** Quando la 048 è entrata su QUESTO db. Letta, non incisa nel codice. */
function migration048AppliedAt(db: Database): { at: string; source: string } {
  const row = db
    .prepare("SELECT applied_at FROM schema_migrations WHERE version = 48")
    .get() as { applied_at?: string } | null;
  if (row?.applied_at) return { at: row.applied_at, source: "schema_migrations.version=48" };
  // Senza la riga non si può sapere quali totali sono gonfiati: meglio scartare
  // tutto lo storico che far passare per comparabile un numero 2,4× più grande.
  return { at: "9999-12-31T00:00:00.000Z", source: "fallback: riga 048 assente, tutto marcato pre-048" };
}

// ── Git: i file toccati dalla consegna ───────────────────────────────────────

const numstatCache = new Map<string, { files: number; churn: number } | null>();

function commitSize(sha: string): { files: number; churn: number } | null {
  const hit = numstatCache.get(sha);
  if (hit !== undefined) return hit;
  const res = spawnSync("git", ["show", "--numstat", "--format=", sha], {
    encoding: "utf8",
    cwd: join(import.meta.dir, ".."),
  });
  if (res.status !== 0 || typeof res.stdout !== "string") {
    numstatCache.set(sha, null);
    return null;
  }
  let files = 0;
  let churn = 0;
  for (const line of res.stdout.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 3) continue;
    files++;
    // I binari escono con "-": contano come file toccato, non come righe.
    const add = Number.parseInt(parts[0] ?? "", 10);
    const del = Number.parseInt(parts[1] ?? "", 10);
    if (Number.isFinite(add)) churn += add;
    if (Number.isFinite(del)) churn += del;
  }
  const out = files > 0 ? { files, churn } : null;
  numstatCache.set(sha, out);
  return out;
}

// ── Braccio A: la board ──────────────────────────────────────────────────────

export interface BoardUnit {
  id: string;
  text: string;
  status: string;
  inProgressAt: string | null;
  endedAt: string;
  /** Token di lavoro: input+output+cache_creation, deduplicati per message.id. */
  workTokens: number;
  /** Rilettura di cache. Tenuta SEPARATA: non è la stessa moneta. */
  cacheReadTokens: number;
  agentMs: number;
  model: string | null;
  filesTouched: number | null;
  churn: number | null;
  userTurns: number | null;
  classByFiles: SizeClass | null;
  classByDuration: SizeClass | null;
  classByTurns: SizeClass | null;
  /** La classe usata nei riepiloghi: `files` se c'è, altrimenti `duration`. */
  sizeClass: SizeClass;
  sizeClassSignal: "files" | "duration";
  /**
   * Dollari, solo dove il transcript dell'agente è ancora sul disco E racconta
   * lo stesso lavoro della card (vedi `transcriptTrusted`). Altrove `null`:
   * un numero che comprende turni di un altro task è peggio di nessun numero.
   */
  costUsd: number | null;
  /** Il totale del reader sullo stesso transcript, per la controprova. */
  readerWorkTokens: number | null;
  readerCacheReadTokens: number | null;
  /** card/reader entro ±25%: il transcript non ha ospitato altro lavoro. */
  transcriptTrusted: boolean;
}

function collectBoard(db: Database, projectId: string, cutoff: string, cutoffMode: CutoffMode): {
  units: BoardUnit[];
  excludedPre048: Array<{ id: string; text: string; inProgressAt: string | null; workTokens: number }>;
  tokenedTotal: number;
  doneTotal: number;
  taskTotal: number;
  coverage: { doneTopLevelPost048: number; agentRun: number; closedByHand: number; doneSubtasksPost048: number; doneSubtasksWithUsage: number };
} {
  const reader = createTranscriptUsageReader();
  const rows = db
    .prepare(
      `SELECT t.id, t.text, t.status, t.archived, t.in_progress_at, t.completed_at, t.updated_at,
              t.agent_ms, t.agent_tokens, t.agent_cache_read_tokens, t.model, t.delivery_commit,
              t.assigned_topic_id, tp.session_key, c.jsonl_path
         FROM tasks t
         LEFT JOIN topics tp ON tp.id = t.assigned_topic_id
         LEFT JOIN claude_code_sessions c ON c.session_key = tp.session_key
        WHERE t.project_id = ? AND t.agent_tokens > 0
        ORDER BY t.in_progress_at`,
    )
    .all(projectId) as unknown as TaskRow[];

  const counts = db
    .prepare("SELECT COUNT(*) AS total, SUM(status = 'done') AS done FROM tasks WHERE project_id = ?")
    .get(projectId) as { total: number; done: number | null };

  // La board mostra le card di primo livello: i figli di fan-out stanno nel
  // dettaglio del padre. Il conteggio di copertura segue la stessa unità.
  const top = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(agent_tokens > 0) AS run FROM tasks
        WHERE project_id = ? AND status = 'done' AND parent_task_id IS NULL AND completed_at >= ?`,
    )
    .get(projectId, cutoff) as { n: number; run: number | null };
  const subs = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(agent_tokens > 0) AS run FROM tasks
        WHERE project_id = ? AND status = 'done' AND parent_task_id IS NOT NULL AND completed_at >= ?`,
    )
    .get(projectId, cutoff) as { n: number; run: number | null };

  const units: BoardUnit[] = [];
  const excluded: Array<{ id: string; text: string; inProgressAt: string | null; workTokens: number }> = [];

  for (const r of rows) {
    // Un task PARTITO prima della 048 ha totali gonfiati ~2,4× (righe non
    // deduplicate) e cache-read persa: non è confrontabile, e nemmeno
    // riparabile a posteriori.
    if (!isComparablePost048(r, cutoff, cutoffMode)) {
      excluded.push({ id: r.id, text: r.text, inProgressAt: r.in_progress_at, workTokens: r.agent_tokens });
      continue;
    }

    const size = r.delivery_commit ? commitSize(r.delivery_commit) : null;
    const userTurns = r.session_key
      ? ((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_key = ? AND role = 'user'")
          .get(r.session_key) as { n: number }).n)
      : null;

    const byFiles = classifyBy(size?.files ?? null, THRESHOLDS.files.smallMax, THRESHOLDS.files.mediumMax);
    const byDuration = classifyBy(r.agent_ms, THRESHOLDS.durationMs.smallMax, THRESHOLDS.durationMs.mediumMax);
    const byTurns = classifyBy(userTurns, THRESHOLDS.turns.smallMax, THRESHOLDS.turns.mediumMax);

    let costUsd: number | null = null;
    let readerWork: number | null = null;
    let readerCacheRead: number | null = null;
    let trusted = false;
    if (r.jsonl_path && existsSync(r.jsonl_path)) {
      const u: SessionUsage = reader.read(r.jsonl_path);
      readerWork = u.billableTokens;
      readerCacheRead = u.cacheReadTokens;
      // Il transcript vale come fonte del PREZZO solo se racconta lo stesso
      // lavoro della card: un topic riusato, o ruotato, porta dentro turni di
      // qualcun altro e i dollari diventano di un altro task.
      const ratio = readerWork > 0 ? r.agent_tokens / readerWork : 0;
      trusted = ratio >= 0.8 && ratio <= 1.25;
      costUsd = !trusted ? null : calculateCostWithCache({
        model: r.model ?? "claude-opus-4-8",
        freshInputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        // Quote DISGIUNTE: quel che non è a un'ora è a cinque minuti.
        cacheCreationTokens: Math.max(0, u.cacheWriteTokens - u.cacheWrite1hTokens),
        cacheCreation1hTokens: u.cacheWrite1hTokens,
      });
    }

    units.push({
      id: r.id,
      text: r.text,
      status: r.status,
      inProgressAt: r.in_progress_at,
      endedAt: r.completed_at ?? r.updated_at,
      workTokens: r.agent_tokens,
      cacheReadTokens: r.agent_cache_read_tokens,
      agentMs: r.agent_ms,
      model: r.model,
      filesTouched: size?.files ?? null,
      churn: size?.churn ?? null,
      userTurns,
      classByFiles: byFiles,
      classByDuration: byDuration,
      classByTurns: byTurns,
      sizeClass: byFiles ?? byDuration ?? "medium",
      sizeClassSignal: byFiles ? "files" : "duration",
      costUsd,
      readerWorkTokens: readerWork,
      readerCacheReadTokens: readerCacheRead,
      transcriptTrusted: trusted,
    });
  }

  return {
    units,
    excludedPre048: excluded,
    tokenedTotal: rows.length,
    doneTotal: counts.done ?? 0,
    taskTotal: counts.total,
    coverage: {
      doneTopLevelPost048: top.n,
      agentRun: top.run ?? 0,
      closedByHand: top.n - (top.run ?? 0),
      doneSubtasksPost048: subs.n,
      doneSubtasksWithUsage: subs.run ?? 0,
    },
  };
}

// ── Braccio B: le chat ───────────────────────────────────────────────────────

export interface ChatUnit {
  topicId: string;
  name: string;
  workTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  userTurns: number;
  /** Sedute separate da più di 30 minuti di silenzio. */
  episodes: number;
  /** Somma della durata delle sedute: il tempo in cui la chat era viva. */
  activeMs: number;
  model: string | null;
  classByTurns: SizeClass | null;
}

function collectChat(db: Database, repoHint: string, cutoff: string): { units: ChatUnit[]; skipped: number } {
  const reader = createTranscriptUsageReader();
  const rows = db
    .prepare(
      `SELECT tp.id, tp.name, tp.project_path, tp.session_key, tp.created_at, tp.updated_at, tp.worktree_id,
              c.jsonl_path,
              (SELECT COUNT(*) FROM tasks tk WHERE tk.assigned_topic_id = tp.id) AS board_bound
         FROM topics tp
         JOIN claude_code_sessions c ON c.session_key = tp.session_key
        WHERE c.jsonl_path IS NOT NULL`,
    )
    .all() as unknown as TopicRow[];

  const units: ChatUnit[] = [];
  let skipped = 0;

  for (const r of rows) {
    if (!(r.project_path ?? "").includes(repoHint)) continue;
    // Un topic legato a un task È il braccio A: contarlo qui lo conterebbe due volte.
    if (r.board_bound > 0) continue;
    if (r.worktree_id) continue;
    if (!existsSync(r.jsonl_path)) { skipped++; continue; }
    // Stessa recinzione temporale del braccio A, così i due campioni guardano
    // la stessa epoca del prodotto (stesso prefisso, stesso bridge).
    if (r.updated_at < cutoff) { skipped++; continue; }

    const msgs = db
      .prepare("SELECT role, timestamp FROM messages WHERE session_key = ? ORDER BY timestamp")
      .all(r.session_key) as unknown as Array<{ role: string; timestamp: string }>;
    if (msgs.length === 0) { skipped++; continue; }

    let userTurns = 0;
    let episodes = 0;
    let activeMs = 0;
    let episodeStart: number | null = null;
    let prev: number | null = null;
    for (const m of msgs) {
      if (m.role === "user") userTurns++;
      const t = Date.parse(m.timestamp);
      if (!Number.isFinite(t)) continue;
      if (prev === null || t - prev > EPISODE_GAP_MS) {
        if (episodeStart !== null && prev !== null) activeMs += prev - episodeStart;
        episodes++;
        episodeStart = t;
      }
      prev = t;
    }
    if (episodeStart !== null && prev !== null) activeMs += prev - episodeStart;

    const lastModel = db
      .prepare("SELECT model FROM messages WHERE session_key = ? AND model IS NOT NULL ORDER BY timestamp DESC LIMIT 1")
      .get(r.session_key) as { model: string | null } | null;

    const u = reader.read(r.jsonl_path);
    if (u.billableTokens === 0) { skipped++; continue; }
    const model = lastModel?.model ?? "claude-opus-4-8";
    units.push({
      topicId: r.id,
      name: r.name,
      workTokens: u.billableTokens,
      cacheReadTokens: u.cacheReadTokens,
      costUsd: calculateCostWithCache({
        model,
        freshInputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheCreationTokens: Math.max(0, u.cacheWriteTokens - u.cacheWrite1hTokens),
        cacheCreation1hTokens: u.cacheWrite1hTokens,
      }),
      userTurns,
      episodes: Math.max(1, episodes),
      activeMs,
      model,
      classByTurns: classifyBy(userTurns, THRESHOLDS.turns.smallMax, THRESHOLDS.turns.mediumMax),
    });
  }

  return { units, skipped };
}

// ── Riepiloghi ───────────────────────────────────────────────────────────────

/**
 * Sotto questa soglia i dollari NON escono come distribuzione.
 *
 * I token li ha ogni task; il PREZZO esatto no: esiste solo dove il transcript
 * dell'agente è ancora sul disco e racconta lo stesso lavoro della card. Su una
 * classe con una o due card prezzate, stampare `median`/`p25`/`p75`/`iqr` è una
 * bugia tipografica: p25 = p75 = max = min = l'unico valore, e `iqr: 0` si legge
 * come «nessuna dispersione» quando la verità è «nessuna misura». Sotto i 4
 * punti quei campi non si emettono affatto e restano i valori grezzi.
 */
export const COST_STATS_MIN = 4;

/** I dollari di un gruppo: o una distribuzione, o i punti che ci sono. */
export type CostSummary =
  | {
      covered: number;
      /** Quante unità del gruppo hanno un prezzo (= `values.length`). */
      sufficient: false;
      /** I valori grezzi, ordinati. Nessuna sintesi: sarebbero un punto solo. */
      values: number[];
      note: string;
    }
  | (Stats & { covered: number; sufficient: true });

export function costSummary(costUsdValues: readonly number[]): CostSummary {
  const sorted = [...costUsdValues].sort((a, b) => a - b);
  if (sorted.length < COST_STATS_MIN) {
    return {
      covered: sorted.length,
      sufficient: false,
      values: sorted,
      note:
        `${sorted.length} osservazioni prezzate (< ${COST_STATS_MIN}): mediana, quartili e IQR NON sono emessi — ` +
        "su così pochi punti sarebbero una dispersione inventata. Restano i valori grezzi.",
    };
  }
  return { ...stats(sorted), covered: sorted.length, sufficient: true };
}

/**
 * La FORBICE di prezzo, quando si ha solo il totale di lavoro.
 *
 * `agent_tokens` è input+output+cache_creation in un numero solo, e le tre voci
 * hanno tariffe da 1× a 5× l'input: un numero secco sarebbe una precisione che
 * il dato non ha. Sotto = tutto input fresco, sopra = tutto output; il vero sta
 * dentro, sempre. Il listino è quello vero (`server/usage/pricing.ts`): non c'è
 * un secondo conto, solo due assunzioni estreme sulla stessa tariffa.
 *
 * Questa è l'UNICA definizione: `scripts/board-vs-chat.ts:bracketCost` delega
 * qui, così i due script non possono prezzare in due modi diversi.
 */
export function bracketCostUsd(
  model: string | null,
  workTokens: number,
  cacheReadTokens: number,
): { lowUsd: number; highUsd: number } | null {
  if (!model) return null;
  return {
    lowUsd: calculateCostWithCache({ model, freshInputTokens: workTokens, outputTokens: 0, cacheReadTokens }),
    highUsd: calculateCostWithCache({ model, freshInputTokens: 0, outputTokens: workTokens, cacheReadTokens }),
  };
}

/** Il prezzo del gruppo come forbice, su TUTTE le unità che hanno un modello. */
export interface CostBracket {
  lowUsd: number;
  highUsd: number;
  /** Unità entrate nella forbice. */
  priced: number;
  /** Unità senza modello scritto: fuori dalla somma, non a zero. */
  unpriced: number;
}

export interface ClassSummary {
  n: number;
  workTokens: Stats;
  cacheReadTokens: Stats;
  /** work + cacheRead, sommato SOLO qui e con un nome che lo dice. */
  readTotalTokens: Stats;
  /**
   * Dollari ESATTI, solo dove il transcript regge la controprova. Copertura
   * bassa per costruzione: leggi `covered` prima di leggere qualunque altra cosa,
   * e sotto i 4 punti qui non c'è nessuna mediana da leggere.
   */
  costUsd: CostSummary;
  /**
   * Dollari come FORBICE, dalle colonne di `tasks` + `tasks.model`: copre tutto
   * il gruppo, al prezzo di un intervallo invece di un numero. È questa la
   * risposta a «quanto costa una card piccola», non `costUsd`, che su small e
   * large ha una manciata di osservazioni.
   */
  costUsdBracket: CostBracket;
}

function summarize(
  units: readonly { workTokens: number; cacheReadTokens: number; costUsd: number | null; model?: string | null }[],
): ClassSummary {
  const costs = units.map((u) => u.costUsd).filter((c): c is number => typeof c === "number");
  const bracket: CostBracket = { lowUsd: 0, highUsd: 0, priced: 0, unpriced: 0 };
  for (const u of units) {
    const b = bracketCostUsd(u.model ?? null, u.workTokens, u.cacheReadTokens);
    if (!b) { bracket.unpriced++; continue; }
    bracket.priced++;
    bracket.lowUsd += b.lowUsd;
    bracket.highUsd += b.highUsd;
  }
  return {
    n: units.length,
    workTokens: stats(units.map((u) => u.workTokens)),
    cacheReadTokens: stats(units.map((u) => u.cacheReadTokens)),
    readTotalTokens: stats(units.map((u) => u.workTokens + u.cacheReadTokens)),
    costUsd: costSummary(costs),
    costUsdBracket: bracket,
  };
}

function byClass(units: readonly BoardUnit[], pick: (u: BoardUnit) => SizeClass | null): Record<SizeClass | "unclassified", ClassSummary> {
  const buckets: Record<string, BoardUnit[]> = { small: [], medium: [], large: [], unclassified: [] };
  for (const u of units) (buckets[pick(u) ?? "unclassified"] ??= []).push(u);
  return {
    small: summarize(buckets.small ?? []),
    medium: summarize(buckets.medium ?? []),
    large: summarize(buckets.large ?? []),
    unclassified: summarize(buckets.unclassified ?? []),
  };
}

/** Quanto i tre classificatori dicono la stessa cosa, dove esistono entrambi. */
function agreement(units: readonly BoardUnit[], a: (u: BoardUnit) => SizeClass | null, b: (u: BoardUnit) => SizeClass | null): {
  n: number;
  exact: number;
  rate: number;
  matrix: Record<string, number>;
} {
  const matrix: Record<string, number> = {};
  let n = 0;
  let exact = 0;
  for (const u of units) {
    const x = a(u);
    const y = b(u);
    if (!x || !y) continue;
    n++;
    if (x === y) exact++;
    const key = `${x}→${y}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }
  return { n, exact, rate: n > 0 ? exact / n : 0, matrix };
}

// ── L'oggetto di riferimento ─────────────────────────────────────────────────

export interface Baseline {
  generatedAt: string;
  dbPath: string;
  projectId: string;
  method: Record<string, string>;
  migration048: { appliedAt: string; source: string };
  board: {
    tasksInProject: number;
    tasksDone: number;
    tasksWithUsage: number;
    excludedPre048: { n: number; reason: string; tasks: Array<{ id: string; text: string; inProgressAt: string | null; workTokens: number }> };
    comparable: number;
    /**
     * Di che STATO sono le unità comparabili — e non sono tutte `done`.
     *
     * `tasksDone` stampato accanto a `comparable` invitava a leggere «le
     * comparabili sono le done»: falso, perché il filtro è `agent_tokens > 0`,
     * che prende anche il lavoro dispatchato e mai consegnato (misurato: 6
     * unità su 84 in stato `backlog`, una delle quali da sola porta 1,02M di
     * lavoro e 33,6 minuti). Il mix va letto, non dedotto: una board dove metà
     * del costo comparabile è lavoro abbandonato non racconta la stessa storia.
     */
    statusMix: Record<string, number>;
    cutoffMode: CutoffMode;
    /**
     * Quanta parte del lavoro CHIUSO sulla board ha davvero un costo scritto.
     * Serve a non scambiare «la board sa quanto costa» per «la board costa
     * poco»: una card chiusa a mano è a costo zero perché nessuno l'ha misurata,
     * non perché non sia costata niente.
     */
    coverage: {
      note: string;
      doneTopLevelPost048: number;
      agentRun: number;
      closedByHand: number;
      /** I figli di fan-out non portano usage: il costo di una card non va sommato ai suoi sotto-task. */
      doneSubtasksPost048: number;
      doneSubtasksWithUsage: number;
    };
    /**
     * Il campione dichiarato comparabile deve reggere una proprietà che nessun
     * turno post-048 può violare: un agente che gira legge la cache, quindi
     * `agent_cache_read_tokens > 0`. Una riga "comparabile" con zero riletture è
     * un residuo pre-048 entrato dalla porta sbagliata. Con `--check` questo
     * conteggio diventa il codice di uscita.
     */
    integrity: {
      rule: string;
      impossibleProfiles: number;
      offenders: Array<{ id: string; text: string; inProgressAt: string | null; endedAt: string; workTokens: number }>;
    };
    overall: ClassSummary;
    cacheReadShareOfRead: Stats;
    byClass: {
      /**
       * `counts` dice da QUALE segnale viene la classe, unità per unità.
       *
       * `primary` è un misto: `files` dove il commit di consegna c'è, `agent_ms`
       * dove manca. Senza questi due numeri il lettore non poteva sapere che il
       * ripiego era la MAGGIORANZA (misurato: 36 per file, 48 per durata) — e la
       * durata è proprio il segnale che correla col costo quasi per costruzione,
       * cioè il rischio di circolarità che questo file dichiara di evitare.
       */
      primary: { signal: string; counts: { files: number; duration: number }; classes: Record<string, ClassSummary> };
      /**
       * Le sole unità classificate per FILE: il campione su cui l'affermazione
       * anti-circolarità regge davvero, senza mescolanza. È più piccolo e dice
       * numeri diversi (mediana della classe piccola: 3,93M contro 1,53M del
       * misto), e questa differenza è un risultato, non un dettaglio da nascondere.
       */
      filesOnly: { signal: string; n: number; classes: Record<string, ClassSummary> };
      duration: { signal: string; classes: Record<string, ClassSummary> };
      turns: { signal: string; classes: Record<string, ClassSummary> };
    };
    classifierAgreement: Record<string, { n: number; exact: number; rate: number; matrix: Record<string, number> }>;
    readerCrossCheck: {
      n: number;
      note: string;
      ratioWork: Stats;
      ratioCacheRead: Stats;
      /** Transcript che raccontano lo stesso lavoro della card (±25%). */
      trusted: number;
      /** Scartati dal conto in dollari perché il topic ha ospitato altro. */
      rejectedMismatch: number;
    };
    costModel: {
      note: string;
      subsample: number;
      mix: { freshInputShare: number; outputShare: number; cacheWriteShare: number; cacheWrite1hShareOfWrites: number } | null;
      usdPerMillionReadTokens: Stats;
    };
  };
  chat: {
    corpus: string;
    units: number;
    skipped: number;
    overall: ClassSummary;
    perEpisode: { note: string; workTokens: Stats; cacheReadTokens: Stats; costUsd: Stats };
    byTurnsClass: Record<string, ClassSummary>;
    episodes: Stats;
    userTurns: Stats;
  };
  comparison: {
    paired: false;
    caveats: string[];
    workTokens: CliffsDelta;
    readTotalTokens: CliffsDelta;
    costUsd: CliffsDelta;
    /**
     * L'unico taglio like-for-like che il corpus storico consente: i turni umani
     * sono l'unico segnale non-token presente in ENTRAMBI i bracci. Resta un
     * segnale di processo, quindi correla col costo: serve a togliere di mezzo
     * le chat-scarto da due battute, non a dimostrare una parità.
     */
    byTurnsClass: Record<string, { boardN: number; chatN: number; boardReadMedian: number; chatReadMedian: number; cliffs: CliffsDelta }>;
  };
}

export function collectBaseline(
  projectId = DEFAULT_PROJECT_ID,
  repoHint = "topics-app",
  cutoffMode: CutoffMode = "start",
): Baseline {
  const path = dbPath();
  if (!existsSync(path)) throw new Error(`Nessun DB in ${path}. Passa DATA_DIR=… se il tuo sta altrove.`);
  const db = new Database(path, { readonly: true });
  try {
    const mig = migration048AppliedAt(db);
    const board = collectBoard(db, projectId, mig.at, cutoffMode);
    const chat = collectChat(db, repoHint, mig.at);

    const withTranscript = board.units.filter((u) => u.readerWorkTokens !== null && u.readerWorkTokens > 0);
    const ratioWork = withTranscript.map((u) => u.workTokens / (u.readerWorkTokens ?? 1));
    const ratioCacheRead = withTranscript
      .filter((u) => (u.readerCacheReadTokens ?? 0) > 0)
      .map((u) => u.cacheReadTokens / (u.readerCacheReadTokens ?? 1));

    // Il prezzo unitario del token letto, misurato dove il transcript c'è: serve
    // a dare un ordine di grandezza in dollari anche alle card che il transcript
    // non ce l'hanno più. È una STIMA dichiarata, non una misura per task.
    const usdPerMRead: number[] = [];
    for (const u of board.units) {
      if (u.costUsd === null) continue;
      const total = (u.readerWorkTokens ?? 0) + (u.readerCacheReadTokens ?? 0);
      if (total > 0) usdPerMRead.push((u.costUsd / total) * 1_000_000);
    }

    // Il mix fresh/output/write sotto i work-token, letto dallo STESSO reader
    // sui transcript ancora vivi: le due colonne della card non lo contengono.
    let fresh = 0;
    let out = 0;
    let write = 0;
    let write1h = 0;
    const mixReader = createTranscriptUsageReader();
    const mixRows = db
      .prepare(
        `SELECT c.jsonl_path AS p
           FROM tasks t JOIN topics tp ON tp.id = t.assigned_topic_id
           JOIN claude_code_sessions c ON c.session_key = tp.session_key
          WHERE t.project_id = ? AND t.agent_tokens > 0 AND c.jsonl_path IS NOT NULL`,
      )
      .all(projectId) as unknown as Array<{ p: string }>;
    for (const { p } of mixRows) {
      if (!existsSync(p)) continue;
      const u = mixReader.read(p);
      fresh += u.inputTokens;
      out += u.outputTokens;
      write += u.cacheWriteTokens;
      write1h += u.cacheWrite1hTokens;
    }
    const workSum = fresh + out + write;
    const mix = workSum > 0
      ? {
          freshInputShare: fresh / workSum,
          outputShare: out / workSum,
          cacheWriteShare: write / workSum,
          cacheWrite1hShareOfWrites: write > 0 ? write1h / write : 0,
        }
      : null;

    const chatShape = (u: ChatUnit) => ({
      workTokens: u.workTokens, cacheReadTokens: u.cacheReadTokens, costUsd: u.costUsd, model: u.model,
    });
    const chatOverall = summarize(chat.units.map(chatShape));
    const chatByTurns: Record<string, ClassSummary> = {};
    for (const c of CLASSES) {
      chatByTurns[c] = summarize(chat.units.filter((u) => u.classByTurns === c).map(chatShape));
    }

    const boardWork = board.units.map((u) => u.workTokens);
    const boardRead = board.units.map((u) => u.workTokens + u.cacheReadTokens);
    const boardCost = board.units.map((u) => u.costUsd).filter((c): c is number => typeof c === "number");
    const chatWork = chat.units.map((u) => u.workTokens);
    const chatRead = chat.units.map((u) => u.workTokens + u.cacheReadTokens);
    const chatCost = chat.units.map((u) => u.costUsd);

    return {
      generatedAt: new Date().toISOString(),
      dbPath: path,
      projectId,
      method: {
        unitBoard: "un task della board = un agente dispatchato in un worktree dedicato; il costo è la somma dei delta di usage dei suoi turni (task-dispatcher.recordUsage → tasks.recordAgentUsage).",
        unitChat: "una chat = un topic Topics con una sessione CLI, NON legato a nessun task e senza worktree; il costo è il totale del reader sul suo JSONL.",
        reader: "server/services/transcript-usage.ts — dedup per message.id, cache_read separata. Lo stesso modulo che alimenta la board e scripts/token-live.ts.",
        pricing: "server/usage/pricing.ts calculateCostWithCache, con la quota a un'ora LETTA dall'usage (2×) e non inferita.",
        neverSummed: "workTokens (input+output+cache_creation) e cacheReadTokens restano separati ovunque; il totale compare solo come readTotalTokens.",
        classSignal: `classe decisa su segnali NON-token: files toccati dal commit di consegna (primario), agent_ms (esecuzione), turni umani. Soglie fisse: files ≤${THRESHOLDS.files.smallMax}/≤${THRESHOLDS.files.mediumMax}, durata ≤${THRESHOLDS.durationMs.smallMax / 60000}min/≤${THRESHOLDS.durationMs.mediumMax / 60000}min, turni ≤${THRESHOLDS.turns.smallMax}/≤${THRESHOLDS.turns.mediumMax}.`,
        notTertiles: "le soglie sono a priori, non terzili del campione: un terzile riempie sempre i tre gruppi e quindi non può falsificare niente.",
        uncertainty: `mediana con intervallo bootstrap percentile 95% (${BOOTSTRAP_N} ricampionamenti, seme ${BOOTSTRAP_SEED} → deterministico); niente intervallo sotto gli 8 punti.`,
        unpaired: "board e chat sono campioni DIVERSI di lavori diversi: il confronto è non appaiato e non normalizzato per taglia (files esiste solo lato board). Cliff's delta con intervallo, non un rapporto di medie.",
        cutoff048:
          "comparabile = task PARTITO dopo l'applicazione della 048 (in_progress_at, con ripiego su completed_at). " +
          "Predicato unico `isComparablePost048`, importato anche da scripts/board-vs-chat.ts: tagliare sulla FINE " +
          "(completed_at ?? updated_at, `--cutoff-mode end`) fa entrare task partiti prima, con agent_tokens gonfiato " +
          "~2,4× e cache-read a zero. Lo si può vedere: `--cutoff-mode end --check` esce 1 e li nomina.",
        costCoverage:
          `i dollari ESATTI (costUsd) esistono solo dove il transcript regge la controprova sul reader (±25%), quindi ` +
          `hanno copertura bassa e disuguale fra le classi. Sotto ${COST_STATS_MIN} osservazioni prezzate NON vengono ` +
          "emessi median/p25/p75/iqr — restano `covered` e i valori grezzi — perché su uno o due punti quei campi si " +
          "leggono come dispersione e non lo sono. Il costo per classe si legge su `costUsdBracket`, che copre tutte " +
          "le unità con un modello e dichiara un intervallo invece di un punto.",
      },
      migration048: { appliedAt: mig.at, source: mig.source },
      board: {
        tasksInProject: board.taskTotal,
        tasksDone: board.doneTotal,
        tasksWithUsage: board.tokenedTotal,
        excludedPre048: {
          n: board.excludedPre048.length,
          reason: "partiti prima della migration 048: agent_tokens gonfiato ~2,4× (righe non deduplicate) e cache-read mai registrata. Non comparabili né recuperabili.",
          tasks: board.excludedPre048,
        },
        comparable: board.units.length,
        statusMix: board.units.reduce<Record<string, number>>((acc, u) => {
          acc[u.status] = (acc[u.status] ?? 0) + 1;
          return acc;
        }, {}),
        cutoffMode,
        coverage: {
          note: "una card chiusa a mano non ha un costo scritto: è invisibile, non gratuita. E i sotto-task di fan-out non portano usage, quindi il costo di una card NON va sommato ai suoi figli.",
          ...board.coverage,
        },
        integrity: {
          rule: "un task comparabile (post-048) DEVE avere agent_cache_read_tokens > 0: un turno di agente rilegge sempre la cache. Zero riletture = riga pre-048 entrata dalla porta sbagliata.",
          impossibleProfiles: board.units.filter((u) => u.cacheReadTokens === 0).length,
          offenders: board.units
            .filter((u) => u.cacheReadTokens === 0)
            .map((u) => ({ id: u.id, text: u.text, inProgressAt: u.inProgressAt, endedAt: u.endedAt, workTokens: u.workTokens })),
        },
        overall: summarize(board.units),
        cacheReadShareOfRead: stats(
          board.units
            .map((u) => (u.workTokens + u.cacheReadTokens > 0 ? u.cacheReadTokens / (u.workTokens + u.cacheReadTokens) : 0)),
        ),
        byClass: {
          primary: {
            signal: "files toccati dal commit di consegna, con ripiego su agent_ms dove il commit manca",
            counts: {
              files: board.units.filter((u) => u.sizeClassSignal === "files").length,
              duration: board.units.filter((u) => u.sizeClassSignal === "duration").length,
            },
            classes: byClass(board.units, (u) => u.sizeClass),
          },
          filesOnly: {
            signal: "SOLO file toccati dal commit di consegna — nessun ripiego sulla durata",
            n: board.units.filter((u) => u.sizeClassSignal === "files").length,
            classes: byClass(board.units.filter((u) => u.sizeClassSignal === "files"), (u) => u.sizeClass),
          },
          duration: { signal: "agent_ms (solo esecuzione)", classes: byClass(board.units, (u) => u.classByDuration) },
          turns: { signal: "messaggi role='user' del topic dell'agente", classes: byClass(board.units, (u) => u.classByTurns) },
        },
        classifierAgreement: {
          "files_vs_duration": agreement(board.units, (u) => u.classByFiles, (u) => u.classByDuration),
          "files_vs_turns": agreement(board.units, (u) => u.classByFiles, (u) => u.classByTurns),
          "duration_vs_turns": agreement(board.units, (u) => u.classByDuration, (u) => u.classByTurns),
        },
        readerCrossCheck: {
          n: withTranscript.length,
          note: "rapporto fra il totale scritto sulla card e il totale che il reader legge ORA sullo stesso transcript. Sotto 1 = il topic ha continuato a lavorare dopo la chiusura del task (o è stato riusato); sopra 1 = il transcript è stato compattato/ruotato sotto i piedi del reader. La mediana a 1,00 è la prova che agent_tokens È il reader; la CODA è il motivo per cui i dollari si prendono solo dai transcript entro ±25%.",
          ratioWork: stats(ratioWork),
          ratioCacheRead: stats(ratioCacheRead),
          trusted: withTranscript.filter((u) => u.transcriptTrusted).length,
          rejectedMismatch: withTranscript.filter((u) => !u.transcriptTrusted).length,
        },
        costModel: {
          note: "i dollari per task esistono solo dove il transcript dell'agente è ancora sul disco E combacia con la card entro ±25% (il reader dà la scomposizione fresh/output/write/read che le due colonne non hanno). Per gli altri resta il prezzo unitario qui sotto, che è una STIMA.",
          subsample: boardCost.length,
          mix,
          usdPerMillionReadTokens: stats(usdPerMRead),
        },
      },
      chat: {
        corpus: `topic con project_path contenente "${repoHint}", non legati a un task, senza worktree, attivi dopo la 048`,
        units: chat.units.length,
        skipped: chat.skipped,
        overall: chatOverall,
        perEpisode: {
          note: "una chat porta più lavori in fila; qui il totale è diviso per il numero di sedute (silenzio > 30 min = seduta nuova). È una divisione dichiarata, non una misura per seduta.",
          workTokens: stats(chat.units.map((u) => u.workTokens / u.episodes)),
          cacheReadTokens: stats(chat.units.map((u) => u.cacheReadTokens / u.episodes)),
          costUsd: stats(chat.units.map((u) => u.costUsd / u.episodes)),
        },
        byTurnsClass: chatByTurns,
        episodes: stats(chat.units.map((u) => u.episodes)),
        userTurns: stats(chat.units.map((u) => u.userTurns)),
      },
      comparison: {
        paired: false,
        caveats: [
          "campioni non appaiati: nessun lavoro è stato fatto in entrambi i modi, quindi la differenza include la differenza fra i lavori.",
          "nessuna normalizzazione per taglia: il classificatore forte (file toccati) esiste solo lato board, una chat non lascia un delivery_commit.",
          "l'unità non è la stessa: un task = una cosa, una chat = una fila di cose (mediana delle sedute riportata in chat.episodes).",
          "modelli misti in entrambi i bracci; i dollari usano il listino corrente, non quello del giorno del turno.",
          "questa baseline dice l'ORDINE DI GRANDEZZA e nient'altro: la decisione 'solo board' richiede un A/B dal vivo sullo stesso lavoro.",
        ],
        workTokens: cliffsDelta(boardWork, chatWork),
        readTotalTokens: cliffsDelta(boardRead, chatRead),
        costUsd: cliffsDelta(boardCost, chatCost),
        byTurnsClass: Object.fromEntries(
          CLASSES.map((c) => {
            const bd = board.units.filter((u) => u.classByTurns === c).map((u) => u.workTokens + u.cacheReadTokens);
            const ch = chat.units.filter((u) => u.classByTurns === c).map((u) => u.workTokens + u.cacheReadTokens);
            return [c, {
              boardN: bd.length,
              chatN: ch.length,
              boardReadMedian: stats(bd).median,
              chatReadMedian: stats(ch).median,
              cliffs: cliffsDelta(bd, ch),
            }];
          }),
        ),
      },
    };
  } finally {
    db.close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const fmtTok = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0));
const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function line(label: string, s: Stats, unit: "tok" | "usd"): string {
  const f = unit === "tok" ? fmtTok : (v: number) => `$${v.toFixed(2)}`;
  const ci = s.medianCi95 ? `[${f(s.medianCi95[0])}–${f(s.medianCi95[1])}]` : "[n<8]";
  return `  ${pad(label, 26)}n=${pad(String(s.n), 5)}mediana ${pad(f(s.median), 10)}CI95 ${pad(ci, 20)}IQR ${pad(f(s.iqr), 10)}max ${f(s.max)}`;
}

/** I dollari: una riga di distribuzione se ce n'è una, altrimenti i punti nudi. */
function costLine(label: string, c: CostSummary): string {
  if (!c.sufficient) {
    const vals = c.values.length === 0 ? "nessuna" : c.values.map((v) => `$${v.toFixed(2)}`).join(", ");
    return `  ${pad(label, 26)} n=${pad(String(c.covered), 4)}\x1b[33mtroppo poche per una distribuzione\x1b[0m — valori: ${vals}`;
  }
  return line(label, c, "usd");
}

/** La forbice del gruppo: copre tutto, e si legge come intervallo, non come punto. */
function bracketLine(label: string, b: CostBracket): string {
  const per = b.priced > 0 ? ` · per unità $${(b.lowUsd / b.priced).toFixed(2)}–$${(b.highUsd / b.priced).toFixed(2)}` : "";
  return `  ${pad(label, 26)} n=${pad(String(b.priced), 4)}totale $${b.lowUsd.toFixed(2)}–$${b.highUsd.toFixed(2)}${per}` +
    (b.unpriced > 0 ? `  (${b.unpriced} senza modello, fuori dal conto)` : "");
}

function printReport(b: Baseline): void {
  console.log(`\n\x1b[1mBASELINE STORICA — board vs chat\x1b[0m  (${b.generatedAt.slice(0, 16).replace("T", " ")})`);
  console.log(`  db ${b.dbPath}`);
  console.log(`  migration 048 applicata il ${b.migration048.appliedAt}  (${b.migration048.source})`);

  console.log(`\n\x1b[1mA — BOARD\x1b[0m  ${b.board.tasksInProject} task nel progetto, ${b.board.tasksDone} done, ${b.board.tasksWithUsage} con usage registrato`);
  console.log(`  esclusi pre-048: ${b.board.excludedPre048.n} (gonfiati ~2,4×, cache-read persa) → comparabili ${b.board.comparable}`);
  const cov = b.board.coverage;
  console.log(
    `  copertura: ${cov.agentRun}/${cov.doneTopLevelPost048} card done post-048 hanno un costo scritto ` +
      `(${((cov.agentRun / Math.max(1, cov.doneTopLevelPost048)) * 100).toFixed(0)}%); ${cov.closedByHand} chiuse a mano, costo ignoto. ` +
      `Sotto-task di fan-out con usage: ${cov.doneSubtasksWithUsage}/${cov.doneSubtasksPost048}.`,
  );
  console.log(line("work token", b.board.overall.workTokens, "tok"));
  console.log(line("cache-read token", b.board.overall.cacheReadTokens, "tok"));
  console.log(line("letti in tutto", b.board.overall.readTotalTokens, "tok"));
  console.log(`  quota cache-read sul letto: mediana ${(b.board.cacheReadShareOfRead.median * 100).toFixed(0)}%`);
  console.log(costLine("dollari (con transcript)", b.board.overall.costUsd));

  console.log(`\n  \x1b[2mper classe — ${b.board.byClass.primary.signal}\x1b[0m`);
  for (const c of [...CLASSES, "unclassified"]) {
    const s = b.board.byClass.primary.classes[c];
    if (!s || s.n === 0) continue;
    console.log(line(`  ${c}`, s.readTotalTokens, "tok"));
    console.log(costLine("      usd esatti", s.costUsd));
    console.log(bracketLine("      usd forbice", s.costUsdBracket));
  }
  console.log(`  \x1b[2maccordo fra classificatori\x1b[0m`);
  for (const [k, v] of Object.entries(b.board.classifierAgreement)) {
    console.log(`    ${pad(k, 22)} n=${pad(String(v.n), 5)}stessa classe ${(v.rate * 100).toFixed(0)}%`);
  }
  console.log(
    `  \x1b[2mcontroprova sul reader\x1b[0m  n=${b.board.readerCrossCheck.n}  card/reader work mediana ${b.board.readerCrossCheck.ratioWork.median.toFixed(2)}×  ` +
      `cache-read ${b.board.readerCrossCheck.ratioCacheRead.median.toFixed(2)}×  ·  ${b.board.readerCrossCheck.trusted} combaciano entro ±25%, ` +
      `${b.board.readerCrossCheck.rejectedMismatch} scartati dal conto in dollari (topic riusato o transcript ruotato, coda fino a ${b.board.readerCrossCheck.ratioWork.max.toFixed(1)}×)`,
  );

  console.log(`\n\x1b[1mB — CHAT\x1b[0m  ${b.chat.units} chat (${b.chat.skipped} scartate)  ·  ${b.chat.corpus}`);
  console.log(line("work token / chat", b.chat.overall.workTokens, "tok"));
  console.log(line("cache-read / chat", b.chat.overall.cacheReadTokens, "tok"));
  console.log(line("letti in tutto / chat", b.chat.overall.readTotalTokens, "tok"));
  console.log(costLine("dollari / chat", b.chat.overall.costUsd));
  console.log(`  sedute per chat: mediana ${b.chat.episodes.median.toFixed(1)}  ·  turni umani: mediana ${b.chat.userTurns.median.toFixed(1)}`);
  console.log(line("dollari / seduta", b.chat.perEpisode.costUsd, "usd"));

  console.log(`\n\x1b[1mCONFRONTO — NON APPAIATO\x1b[0m`);
  const d = b.comparison.readTotalTokens;
  console.log(`  Cliff's delta sui token letti: ${d.delta.toFixed(2)} ${d.ci95 ? `CI95 [${d.ci95[0].toFixed(2)}, ${d.ci95[1].toFixed(2)}]` : "(n troppo piccolo)"} — ${d.separates ? "l'intervallo NON contiene lo zero" : "\x1b[33ml'intervallo CONTIENE lo zero: nessuna differenza dimostrata\x1b[0m"}`);
  console.log(`  \x1b[2mstesso taglio per turni umani (l'unico segnale non-token comune ai due bracci)\x1b[0m`);
  for (const [c, v] of Object.entries(b.comparison.byTurnsClass)) {
    const ci = v.cliffs.ci95 ? `CI95 [${v.cliffs.ci95[0].toFixed(2)}, ${v.cliffs.ci95[1].toFixed(2)}]` : "n<8, nessun intervallo";
    console.log(`    ${pad(c, 10)}board n=${pad(String(v.boardN), 4)}${pad(fmtTok(v.boardReadMedian), 9)} · chat n=${pad(String(v.chatN), 4)}${pad(fmtTok(v.chatReadMedian), 9)} · δ ${v.cliffs.delta.toFixed(2)} ${ci}`);
  }
  for (const c of b.comparison.caveats) console.log(`  \x1b[2m· ${c}\x1b[0m`);
  console.log("");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const modeArg = flag("--cutoff-mode");
  if (modeArg !== null && modeArg !== "start" && modeArg !== "end") {
    console.error("--cutoff-mode vuole 'start' (default) o 'end'");
    process.exit(2);
  }
  const baseline = collectBaseline(
    flag("--project") ?? DEFAULT_PROJECT_ID,
    "topics-app",
    (modeArg ?? "start") as CutoffMode,
  );
  const out = flag("--out");
  if (argv.includes("--out")) {
    if (!out) { console.error("--out vuole un percorso"); process.exit(2); }
    writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.error(`scritto ${out}`);
  }
  if (argv.includes("--json")) console.log(JSON.stringify(baseline, null, 2));
  else printReport(baseline);

  if (argv.includes("--check")) {
    const bad = baseline.board.integrity;
    if (bad.impossibleProfiles > 0) {
      console.error(
        `\n✗ ${bad.impossibleProfiles} task dichiarati comparabili hanno cache-read a zero — sono pre-048.\n  ${bad.rule}`,
      );
      for (const o of bad.offenders) {
        console.error(`  · ${o.id} partito ${o.inProgressAt ?? "?"} chiuso ${o.endedAt} work ${o.workTokens} — ${o.text.slice(0, 60)}`);
      }
      process.exit(1);
    }
    console.error(`\n✓ ${baseline.board.comparable} task comparabili, nessun profilo impossibile (cutoff su '${baseline.board.cutoffMode}').`);
  }
}
