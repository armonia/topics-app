/**
 * Automatic review of pull requests opened or updated after the feature is switched on, on a
 * cheap model, run on this machine.
 *
 * Nothing is hard-wired to a repository: the repo to watch and the review workflow come from
 * the environment (`REVIEW_PR_REPO`, `REVIEW_PR_WORKFLOW`). Both empty means the tick does
 * nothing.
 *
 * - First pass ever: the PRs already open are recorded as seen (with their head commit) and NOT
 *   reviewed, so switching the feature on never fires a burst of reviews on the backlog.
 * - One review per tick at most; the other pending PRs wait for the next tick.
 * - Each review is written to a verdict file. Only confirmed defects open a card in review on the
 *   board of the project that owns the repo; nothing is ever posted back to GitHub.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REVIEW_PR_MODEL = "claude-haiku-5-5";
const REVIEW_TIMEOUT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 10 * 60_000;

export interface PrReviewConfig {
  /** `owner/name` of the repository to watch. */
  repo: string;
  /** Path of the `revisione-pr` workflow file. */
  workflowPath: string;
  /** Where the read-only clone, the verdict files and the state live. */
  dataDir: string;
  intervalMs: number;
}

export interface OpenPr {
  number: number;
  title: string;
  baseRefName: string;
  headRefOid: string;
}

/** Reads the configuration; null when the feature is off (empty repo or workflow). */
export function readPrReviewConfig(env: NodeJS.ProcessEnv, appDataDir: string): PrReviewConfig | null {
  const repo = (env.REVIEW_PR_REPO || "").trim();
  const workflowPath = (env.REVIEW_PR_WORKFLOW || "").trim();
  if (!repo || !workflowPath) return null;
  return {
    repo,
    workflowPath,
    dataDir: join(appDataDir, "revisione-pr"),
    intervalMs: Number(env.REVIEW_PR_INTERVAL_MS) > 0 ? Number(env.REVIEW_PR_INTERVAL_MS) : POLL_INTERVAL_MS,
  };
}

/** A PR is reviewed once per head commit: a new push to the PR asks for a new review. */
export function reviewKey(pr: Pick<OpenPr, "number" | "headRefOid">): string {
  return `${pr.number}@${pr.headRefOid}`;
}

/** The open PRs whose current head has no verdict yet. */
export function pendingPullRequests(open: OpenPr[], done: ReadonlySet<string>): OpenPr[] {
  return open.filter((pr) => !done.has(reviewKey(pr)));
}

/**
 * Two lenses instead of the workflow's five: a headless run has to finish well inside the ten
 * minutes a `claude -p` session is given (the five-lens run on a two-file PR was killed at 602 s,
 * with its verdict lost), and the cost of a review that runs unattended on every push stays small.
 */
const REVIEW_LENSES = [
  { key: "correttezza", lens: "Correttezza del comportamento cambiato: casi limite che capitano davvero, regressioni rispetto alla base." },
  { key: "robustezza", lens: "Robustezza nell'ambiente vero: errori di servizi esterni, concorrenza, un'eccezione o un evento perso, ordine dei passi di build e deploy." },
];

/** The prompt that asks the model to run the workflow on one PR, with args as JSON. */
export function buildReviewPrompt(workflowPath: string, args: { repo: string; base: string; head: string; context?: string }): string {
  const { context, ...rest } = args;
  const payload = JSON.stringify({ ...rest, ...(context ? { contesto: context } : {}), modello: "haiku", lenti: REVIEW_LENSES });
  return [
    `Esegui il workflow di revisione «revisione-pr» (file ${workflowPath}) con args ${payload}.`,
    "Restituisci solo il risultato del workflow, in JSON.",
  ].join("\n");
}

export interface Defect {
  title: string;
  severity?: string;
  file?: string;
  line?: number | string;
  scenario?: string;
}

/** What the tick needs to put a card on the board; null when no project owns the repo. */
export interface CardRequest {
  repo: string;
  idempotencyKey: string;
  title: string;
  description: string;
}

export interface PrReviewDeps {
  listOpenPrs(repo: string): Promise<OpenPr[]>;
  /** Makes the PR head and the point it forked from the base available in the clone, returns both. */
  prepareRefs(clone: string, repo: string, pr: OpenPr): Promise<{ base: string; head: string }>;
  runReview(prompt: string, cwd: string): Promise<string>;
  /** True when a board project owns this repo, so a card can be opened for its defects. */
  hasBoard(repo: string): Promise<boolean>;
  /** Opens a card in review on the board that owns the repo. */
  openCard(card: CardRequest): Promise<void>;
  log(message: string, err?: unknown): void;
}

function run(file: string, args: string[], opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeout, env: opts.env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0]}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** `owner/name` out of an https or ssh git remote URL; null when it is not a recognisable one. */
export function repoFromRemoteUrl(url: string): string | null {
  const m = url.trim().match(/[:/]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/** First directory whose `origin` points at `repo` (case-insensitive, as GitHub is). */
export async function findProjectDirForRepo(
  repo: string,
  dirs: string[],
  remoteOf: (dir: string) => Promise<string | null>,
): Promise<string | null> {
  const want = repo.toLowerCase();
  for (const dir of dirs) {
    const url = await remoteOf(dir);
    const found = url ? repoFromRemoteUrl(url) : null;
    if (found && found.toLowerCase() === want) return dir;
  }
  return null;
}

/**
 * The confirmed defects out of what `claude -p --output-format json` printed. The model answers
 * with the workflow result (an object with `reggono`, the defects that held up), possibly wrapped in
 * prose or a code fence. Returns null when no such object can be read: the caller treats that as a
 * failed review, never as "no defects".
 */
export function parseDefects(raw: string): Defect[] | null {
  let text = raw;
  try {
    const envelope = JSON.parse(raw) as { result?: unknown };
    if (typeof envelope.result === "string") text = envelope.result;
    else if (envelope.result && typeof envelope.result === "object") text = JSON.stringify(envelope.result);
  } catch { /* not an envelope: read the text as it is */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const verdict = JSON.parse(text.slice(start, end + 1)) as { reggono?: unknown };
    if (!Array.isArray(verdict.reggono)) return null;
    return verdict.reggono.filter((d): d is Defect => !!d && typeof d === "object" && typeof (d as Defect).title === "string");
  } catch {
    return null;
  }
}

/** Title and body of the card for a review that confirmed defects. */
export function buildCard(repo: string, pr: OpenPr, defects: Defect[], verdictFile: string): CardRequest {
  const lines = defects.map((d) => {
    const where = d.file ? ` (${d.file}${d.line ? `:${d.line}` : ""})` : "";
    const severity = d.severity ? `[${d.severity}] ` : "";
    return `- ${severity}${d.title}${where}${d.scenario ? `\n  Scenario: ${d.scenario}` : ""}`;
  });
  return {
    repo,
    idempotencyKey: `revisione-pr:${repo}:${reviewKey(pr)}`,
    title: `Revisione automatica PR #${pr.number}: ${defects.length} ${defects.length === 1 ? "difetto confermato" : "difetti confermati"}`,
    description: [
      `PR: https://github.com/${repo}/pull/${pr.number} (${pr.title})`,
      `Commit rivisto: ${pr.headRefOid}`,
      "",
      "Difetti confermati dalla revisione automatica (modello economico):",
      ...lines,
      "",
      `Esito completo: ${verdictFile}`,
    ].join("\n"),
  };
}

const MAX_ATTEMPTS = 3;

interface ReviewState {
  /** `number@headRefOid` of every PR already seen or reviewed. */
  done: string[];
  /** Failed attempts per key; at MAX_ATTEMPTS the PR is given up so it cannot block the others. */
  attempts: Record<string, number>;
}

export const createPrReviewDeps = (
  board: { hasBoard(repo: string): Promise<boolean>; openCard(card: CardRequest): Promise<void> },
): PrReviewDeps => ({
  async listOpenPrs(repo) {
    const out = await run("gh", ["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", "number,title,baseRefName,headRefOid"], {});
    return JSON.parse(out) as OpenPr[];
  },
  async prepareRefs(clone, repo, pr) {
    const exists = await readFile(join(clone, "HEAD")).then(() => true, () => false);
    if (!exists) await run("git", ["clone", "--quiet", "--bare", `https://github.com/${repo}.git`, clone], {});
    const baseRef = `refs/revisione/base/${pr.baseRefName}`;
    const head = `refs/revisione/pr/${pr.number}`;
    await run("git", ["-C", clone, "fetch", "--quiet", "--force", "origin", `+refs/heads/${pr.baseRefName}:${baseRef}`, `+refs/pull/${pr.number}/head:${head}`], {});
    // The workflow diffs base against head: against a base that moved on, that would also show every
    // change main got since the PR forked, so the base is the fork point.
    const base = (await run("git", ["-C", clone, "merge-base", baseRef, head], {})).trim();
    return { base, head };
  },
  async runReview(prompt, cwd) {
    return run("claude", ["-p", prompt, "--model", REVIEW_PR_MODEL, "--output-format", "json", "--permission-mode", "bypassPermissions"], {
      cwd,
      timeout: REVIEW_TIMEOUT_MS,
      // Without this the Workflow tool detaches a long run into the background, the session ends its
      // turn with "launched" and the verdict never comes back on stdout.
      env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    });
  },
  hasBoard: (repo) => board.hasBoard(repo),
  openCard: (card) => board.openCard(card),
  log(message, err) {
    console.warn(`[RevisionePR] ${message}`, err ?? "");
  },
});

async function loadState(dir: string): Promise<ReviewState | null> {
  const raw = await readFile(join(dir, "reviewed.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Partial<ReviewState>;
  return { done: parsed.done ?? [], attempts: parsed.attempts ?? {} };
}

async function saveState(dir: string, state: ReviewState): Promise<void> {
  await writeFile(join(dir, "reviewed.json"), JSON.stringify(state));
}

/**
 * One pass. The very first one only records the open PRs as seen. Every later one reviews AT MOST
 * one PR: the first pending one, those that failed fewer times first. A failed review stays pending
 * and is retried on a later pass, up to MAX_ATTEMPTS. Returns the keys reviewed in this pass.
 */
export async function tickPrReview(cfg: PrReviewConfig, deps: PrReviewDeps): Promise<string[]> {
  await mkdir(cfg.dataDir, { recursive: true });
  const open = await deps.listOpenPrs(cfg.repo);
  const state = await loadState(cfg.dataDir);
  if (!state) {
    await saveState(cfg.dataDir, { done: open.map(reviewKey), attempts: {} });
    deps.log(`prima accensione: ${open.length} PR aperte registrate come già viste, nessuna revisione`);
    return [];
  }
  const pending = pendingPullRequests(open, new Set(state.done)).sort(
    (a, b) => (state.attempts[reviewKey(a)] ?? 0) - (state.attempts[reviewKey(b)] ?? 0) || a.number - b.number,
  );
  const pr = pending[0];
  if (!pr) return [];
  if (!(await deps.hasBoard(cfg.repo))) {
    deps.log(`nessun progetto sulla board possiede ${cfg.repo}: la PR #${pr.number} aspetta`);
    return [];
  }
  const key = reviewKey(pr);
  try {
    const refs = await deps.prepareRefs(join(cfg.dataDir, "clone.git"), cfg.repo, pr);
    const context = `PR #${pr.number} del repository ${cfg.repo}: ${pr.title}`;
    const raw = await deps.runReview(buildReviewPrompt(cfg.workflowPath, { repo: join(cfg.dataDir, "clone.git"), ...refs, context }), cfg.dataDir);
    const verdictFile = join(cfg.dataDir, `esito-${pr.number}-${pr.headRefOid.slice(0, 12)}.json`);
    await writeFile(verdictFile, raw);
    const defects = parseDefects(raw);
    if (!defects) throw new Error("esito del workflow illeggibile");
    if (defects.length > 0) await deps.openCard(buildCard(cfg.repo, pr, defects, verdictFile));
    state.done.push(key);
    delete state.attempts[key];
    await saveState(cfg.dataDir, state);
    return [key];
  } catch (err) {
    const n = (state.attempts[key] ?? 0) + 1;
    state.attempts[key] = n;
    if (n >= MAX_ATTEMPTS) {
      state.done.push(key);
      deps.log(`PR #${pr.number}: revisione fallita ${n} volte, la lascio`, err);
    } else {
      deps.log(`PR #${pr.number}: revisione fallita (${n}/${MAX_ATTEMPTS}), riprova a un giro successivo`, err);
    }
    await saveState(cfg.dataDir, state);
    return [];
  }
}

/** Starts the periodic pass. Returns null (and starts nothing) when the feature is off. */
export function startPrReviewTick(cfg: PrReviewConfig | null, deps: PrReviewDeps): NodeJS.Timeout | null {
  if (!cfg) return null;
  let busy = false;
  const pass = () => {
    if (busy) return;
    busy = true;
    tickPrReview(cfg, deps)
      .catch((err) => deps.log("giro di revisione fallito", err))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(pass, cfg.intervalMs);
  timer.unref?.();
  pass();
  return timer;
}
