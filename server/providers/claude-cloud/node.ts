// Il cloud di Claude come NODO della corsia remota (KANBAN-76): una card con la macchina
// «Cloud Claude» non gira qui, gira in una sessione cloud, e di qui resta solo il polling.
// La corsia (task-dispatcher-remote-node.ts) fa già tutto il resto: specchia stato e commenti,
// pianta il ramo consegnato, porta la card in review, la rimette in coda dopo un riavvio.
// Questo file traduce le quattro chiamate del NodeDeps in quelle dell'API delle sessioni.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BundleResult, CreateRunBody, NodeRunComment, NodeRunReport } from "../../services/node-client";
import { CloudApi, cloudApiIsReal, type CloudEvent } from "./api";
import { isPermissionAsk } from "./events";
import { runBounded } from "../../lib/bounded-spawn";

/** Il base_url della riga `machines` del cloud: non è un indirizzo, è un segnaposto. */
export const CLOUD_NODE_BASE_URL = "claude-cloud://";
export const CLOUD_NODE_HOSTNAME = "claude-cloud";
export const CLOUD_NODE_NAME = "Cloud Claude";
/** La corsia rifiuta un nodo senza token: per il cloud l'autenticazione è il login di Claude Code. */
export const CLOUD_NODE_TOKEN = "claude-cloud";

/**
 * Is the cloud reachable from this machine? Claude Code's own login in the Keychain, the
 * same credential `claude --cloud` uses. `TOPICS_CLAUDE_CLOUD=0` switches it off.
 */
export function cloudCredentialsPresent(): boolean {
  if (process.platform !== "darwin" || process.env.TOPICS_CLAUDE_CLOUD === "0") return false;
  // Il server di test non legge il Portachiavi di login (test-server.ts): niente cloud lì.
  if (process.env.TOPICS_CREDENTIALS_KEYCHAIN === "0") return false;
  // Sincrono e una volta sola, al boot (server.ts, providers/index.ts): decide se la riga esiste.
  const probe = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
  return probe.exitCode === 0;
}

export function isCloudBaseUrl(baseUrl: string | null | undefined): boolean {
  return !!baseUrl && baseUrl.startsWith(CLOUD_NODE_BASE_URL);
}

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};
/** Qualità prima: senza un modello Claude esplicito sulla card, Opus. */
export const CLOUD_DEFAULT_MODEL = "claude-opus-5-5";

/** «claude-code:sonnet», «sonnet», «claude-sonnet-5-5» → id completo; un modello non Claude → default. */
export function cloudModelFor(selection: string | null | undefined): string {
  const raw = (selection ?? "").split(":").at(-1)!.trim().toLowerCase();
  if (MODEL_ALIASES[raw]) return MODEL_ALIASES[raw];
  return raw.startsWith("claude-") ? raw : CLOUD_DEFAULT_MODEL;
}

/**
 * «git@github.com:o/r.git», «https://github.com/o/r», «ssh://git@ssh.github.com:443/o/r.git»,
 * alias ssh «git@github.com-lavoro:o/r» → «o/r». Qualunque altro host → null: l'host si
 * confronta intero, mai come sottostringa (notgithub.com, github.com.evil.example, un
 * percorso locale con «github.com» dentro sono altri repo).
 */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);

/**
 * Un alias ssh («github.com-lavoro») è GitHub solo se ~/.ssh/config lo porta lì: lo dice
 * `ssh -G`, che risolve senza connettersi. Il nome da solo non prova niente
 * (`github.com-evil.com` è un dominio vero).
 */
async function sshAliasIsGithub(alias: string): Promise<boolean> {
  if (!/^[\w.-]+$/.test(alias)) return false;
  const r = await runBounded(["ssh", "-G", "--", alias], { stdout: "pipe", stderr: "ignore", timeoutMs: 5_000 });
  if (r.exitCode !== 0) return false;
  const hostname = r.stdout.match(/^hostname (\S+)$/m)?.[1]?.toLowerCase();
  return !!hostname && GITHUB_HOSTS.has(hostname);
}

interface ParsedOrigin { host: string; slug: string; viaSsh: boolean }

function parseOrigin(originUrl: string): ParsedOrigin | null {
  const raw = originUrl.trim();
  let host: string;
  let path: string;
  let viaSsh: boolean;
  const scp = raw.match(/^(?:[\w.-]+@)?([^:/@\s]+):(?!\/\/)(.+)$/);
  if (scp) {
    [host, path, viaSsh] = [scp[1]!, scp[2]!, true];
  } else {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (!["https:", "http:", "ssh:", "git+ssh:", "git:"].includes(u.protocol)) return null;
    [host, path, viaSsh] = [u.hostname, u.pathname, u.protocol === "ssh:" || u.protocol === "git+ssh:"];
  }
  const m = path.replace(/^\/+/, "").match(/^([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { host: host.toLowerCase(), slug: `${m[1]}/${m[2]}`, viaSsh } : null;
}

/** Solo gli host GitHub scritti per intero; un alias ssh non lo è (vedi `resolveGithubSlug`). */
export function githubSlug(originUrl: string): string | null {
  const o = parseOrigin(originUrl);
  return o && GITHUB_HOSTS.has(o.host) ? o.slug : null;
}

/** Come `githubSlug`, più gli alias ssh che `ssh -G` risolve su GitHub. */
export async function resolveGithubSlug(originUrl: string): Promise<string | null> {
  const o = parseOrigin(originUrl);
  if (!o) return null;
  if (GITHUB_HOSTS.has(o.host)) return o.slug;
  return o.viaSsh && (await sshAliasIsGithub(o.host)) ? o.slug : null;
}

export type GitRun = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Un origin che non risponde non deve fermare il giro di tutte le card remote: 60 s e via. */
const GIT_TIMEOUT_MS = 60_000;
const realGit: GitRun = async (args, cwd) => {
  const r = await runBounded(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeoutMs: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.exitCode ?? 124, stdout: r.stdout, stderr: r.stderr || r.spawnError || (r.timedOut ? "timeout" : "") };
};

export interface CloudNodeDeps {
  api: CloudApi;
  /** Il checkout della card, per costruire il bundle del ramo consegnato. */
  repoPathOfTask: (taskId: string) => string | null;
  git?: GitRun;
  /** Silenzio dopo il quale una sessione non finita è ferma (default 15 min). */
  stallMs?: number;
  now?: () => number;
  /**
   * Dove restano le corse vive fra un riavvio e l'altro. La corsia ricorda l'ultima corsa solo
   * in memoria: dopo un riavvio rimette la card in coda e chiama `createRun` senza cancellare
   * niente. Un nodo accoppiato è idempotente su `originTaskId`; questo file lo è grazie a qui.
   */
  statePath?: string;
}

interface CloudRun {
  taskId: string;
  originUrl: string;
  branch: string;
  cursor?: string;
  /** La corsia «adesca» il primo rapporto e non lo scrive: il primo resta vuoto apposta. */
  reported: boolean;
  done: boolean;
  failed: boolean;
  resultText: string;
  resultId?: string;
  publishedBranch?: string;
  asks: Map<string, { tool: string; answered: boolean }>;
  lastEventAt: number;
  /** Giri di fila in cui origin non ha risposto alla ricerca del ramo consegnato. */
  originFails: number;
  /** Una card che il cloud non può prendere: si chiude in review col motivo, senza sessione. */
  refused?: string;
  /** La sessione è finita e consegnata: un cancel dopo non la deve archiviare. */
  finished?: boolean;
  /** Il bundle pronto, calcolato quando la sessione finisce (base = ciò che il checkout ha già). */
  bundle?: { base: string; result: BundleResult };
}

interface PersistedRun { taskId: string; originUrl: string; branch: string }

function prompt(body: CreateRunBody, branch: string, revision: string): string {
  return [
    body.text,
    body.description?.trim() ? `\n${body.description.trim()}` : "",
    "",
    "---",
    `Lavora su un ramo nuovo \`${branch}\`, creato da \`${revision}\`. Committa il lavoro e fai push di quel ramo su origin.`,
    "Non aprire pull request e non toccare altri rami.",
    "Chiudi con un riassunto breve: cosa hai cambiato e come l'hai verificato.",
  ].join("\n");
}

const ORIGIN_RETRIES = 10;

const EMPTY: Omit<NodeRunReport, "status" | "dispatchState" | "dispatchError" | "comments"> = {
  deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
};

export function createCloudNodeClient(deps: CloudNodeDeps) {
  const git = deps.git ?? realGit;
  const runs = new Map<string, CloudRun>();
  const stallMs = deps.stallMs ?? 15 * 60_000;
  const now = deps.now ?? Date.now;

  function loadPersisted(): Record<string, PersistedRun> {
    if (!deps.statePath || !existsSync(deps.statePath)) return {};
    try { return JSON.parse(readFileSync(deps.statePath, "utf8")) as Record<string, PersistedRun>; }
    catch { return {}; }
  }
  function savePersisted(all: Record<string, PersistedRun>) {
    if (!deps.statePath) return;
    mkdirSync(dirname(deps.statePath), { recursive: true });
    const tmp = `${deps.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, deps.statePath);
  }
  function persist(sid: string, run: PersistedRun) { savePersisted({ ...loadPersisted(), [sid]: run }); }
  function forget(sid: string) {
    const all = loadPersisted();
    if (sid in all) { delete all[sid]; savePersisted(all); }
  }

  function newRun(p: PersistedRun): CloudRun {
    return { ...p, reported: false, done: false, failed: false, resultText: "", asks: new Map(), lastEventAt: now(), originFails: 0 };
  }

  /** `undefined` = origin non ha risposto (si riprova), `null` = il ramo non c'è. */
  async function remoteSha(originUrl: string, ref: string): Promise<string | null | undefined> {
    const r = await git(["ls-remote", originUrl, ref]);
    if (r.code !== 0) return undefined;
    return r.stdout.split(/\s+/)[0] || null;
  }

  async function defaultBranch(originUrl: string): Promise<string> {
    const r = await git(["ls-remote", "--symref", originUrl, "HEAD"]);
    return r.stdout.match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? "main";
  }

  /** Ferma la sessione e smette di seguirla. Best effort: l'API non dice se si è fermata. */
  async function stop(sid: string) {
    runs.delete(sid);
    forget(sid);
    try { await deps.api.stopSession(sid); } catch { /* già chiusa */ }
  }

  /**
   * Il bundle del ramo consegnato, contro un commit che il checkout HA già: la base è il
   * merge-base fra la punta del ramo e l'HEAD del checkout, non l'HEAD di origin al lancio
   * (un checkout indietro rispetto a origin non lo avrebbe, e l'impianto rifiuterebbe).
   * Repo nudo temporaneo con gli oggetti del checkout in prestito: il checkout non si tocca.
   */
  async function prepareBundle(run: CloudRun, branch: string): Promise<{ base: string; result: BundleResult }> {
    const repo = deps.repoPathOfTask(run.taskId);
    if (!repo) throw new Error("questo progetto non ha un checkout su questa macchina");
    const dir = await mkdtemp(join(tmpdir(), "topics-cloud-bundle-"));
    try {
      const must = async (args: string[], cwd: string, what: string) => {
        const r = await git(args, cwd);
        if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim() || `exit ${r.code}`}`);
        return r.stdout.trim();
      };
      const objects = await must(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo, "checkout illeggibile");
      const localHead = await must(["rev-parse", "HEAD"], repo, "HEAD del checkout");
      await must(["init", "--bare", "-q", dir], tmpdir(), "repo temporaneo");
      await writeFile(join(dir, "objects/info/alternates"), join(objects, "objects") + "\n");
      await must(["fetch", "-q", run.originUrl, `+refs/heads/${branch}:refs/heads/${branch}`], dir, `fetch del ramo ${branch}`);
      const base = await must(["merge-base", `refs/heads/${branch}`, localHead], dir, "il ramo non ha storia in comune col checkout");
      const tip = await must(["rev-parse", `refs/heads/${branch}`], dir, "punta del ramo");
      if (tip === base) return { base, result: { empty: true } };
      const file = join(dir, "out.bundle");
      await must(["bundle", "create", file, `refs/heads/${branch}`, `^${base}`], dir, "bundle");
      return { base, result: { empty: false, bytes: new Uint8Array(await readFile(file)) } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function apply(run: CloudRun, ev: CloudEvent) {
    if (ev.type === "result") {
      run.done = true;
      run.failed = ev.subtype !== "success";
      run.resultText = typeof ev.result === "string" ? ev.result : run.resultText;
      run.resultId = typeof ev.uuid === "string" ? ev.uuid : run.resultId;
    } else if (ev.type === "system" && ev.subtype === "code_change_published" && typeof ev.branch === "string") {
      run.publishedBranch = ev.branch;
    } else if (isPermissionAsk(ev) && typeof ev.request_id === "string") {
      const req = (ev.request ?? {}) as { tool_name?: string };
      run.asks.set(ev.request_id, { tool: req.tool_name ?? "tool", answered: false });
    } else if (ev.type === "control_cancel_request" && typeof ev.request_id === "string") {
      // La sessione ha ritirato la domanda: non aspetta più nessuno.
      const a = run.asks.get(ev.request_id);
      if (a) a.answered = true;
    } else if (ev.type === "control_response") {
      const id = (ev.response as { request_id?: string } | undefined)?.request_id;
      const a = id ? run.asks.get(id) : undefined;
      if (a) a.answered = true;
    }
  }

  const note = (id: string, content: string): NodeRunComment =>
    ({ id, author: "system", kind: "service", createdAt: new Date().toISOString(), content });

  return {
    async createRun(input: { body: CreateRunBody }): Promise<{ runId: string }> {
      const { body } = input;
      // Dopo un riavvio la corsia rilancia la stessa card: la sessione viva si riprende.
      for (const [sid, p] of Object.entries(loadPersisted())) {
        if (p.taskId !== body.originTaskId) continue;
        if (!runs.has(sid)) runs.set(sid, newRun(p));
        return { runId: sid };
      }
      const slug = await resolveGithubSlug(body.originUrl);
      // Fuori da GitHub la sessione cloud non può clonare (il finto della suite e2e sì). Non è
      // un nodo muto da riprovare: la card va in review col motivo.
      if (!slug && cloudApiIsReal()) {
        const sid = `refused-${crypto.randomUUID()}`;
        runs.set(sid, { ...newRun({ taskId: body.originTaskId, originUrl: body.originUrl, branch: "" }), refused: `il cloud di Claude clona solo da GitHub, e l'origin di questo progetto è ${body.originUrl}` });
        return { runId: sid };
      }
      const revision = await defaultBranch(body.originUrl);
      const branch = `claude/card-${body.originTaskId.slice(0, 8)}-${crypto.randomUUID().slice(0, 4)}`;
      const sid = await deps.api.createSession({
        title: body.text.slice(0, 60),
        prompt: prompt(body, branch, revision),
        source: { repo: slug ?? body.originUrl, revision },
        deliveryBranch: branch,
        model: cloudModelFor(body.model),
        effort: body.effort ?? undefined,
        environmentId: await deps.api.defaultEnvironmentId(),
      });
      const p = { taskId: body.originTaskId, originUrl: body.originUrl, branch };
      runs.set(sid, newRun(p));
      persist(sid, p);
      return { runId: sid };
    },

    async readRun(input: { runId: string }): Promise<NodeRunReport> {
      const run = runs.get(input.runId);
      if (!run) return { status: "in_progress", dispatchState: "working", dispatchError: null, comments: [], ...EMPTY };
      const first = !run.reported;
      run.reported = true;
      if (run.refused) {
        if (first) return { status: "in_progress", dispatchState: "working", dispatchError: null, comments: [], ...EMPTY };
        runs.delete(input.runId);
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_refused", comments: [note(`refused-${input.runId}`, `Non parte nel cloud: ${run.refused}.`)], reason: run.refused, ...EMPTY };
      }
      for (;;) {
        const page = await deps.api.events(input.runId, run.cursor);
        if (page.last_id) run.cursor = page.last_id;
        for (const ev of page.data) apply(run, ev);
        if (page.data.length) run.lastEventAt = now();
        if (!page.has_more) break;
      }
      const link = `https://claude.ai/code/${input.runId}`;
      const comments: NodeRunComment[] = [];
      if (!first) {
        for (const [id, a] of run.asks) {
          if (!a.answered) comments.push(note(`ask-${id}`, `La sessione cloud chiede il permesso per ${a.tool}: rispondi su ${link}`));
        }
      }
      if (first) return { status: "in_progress", dispatchState: "working", dispatchError: null, comments, ...EMPTY };

      // Una VM in pausa o un polling che non vede più niente: la card è ferma, mai consegnata.
      // Una domanda aperta non è silenzio: la sessione aspetta una persona, non è ferma.
      const waitingOnPerson = [...run.asks.values()].some((a) => !a.answered);
      if (!run.done && !waitingOnPerson && now() - run.lastEventAt > stallMs) {
        const minutes = Math.round(stallMs / 60_000);
        await stop(input.runId);
        comments.push(note(`stall-${input.runId}`, `La sessione cloud non manda eventi da ${minutes} minuti: l'ho fermata. Guardala su ${link}`));
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_session_stalled", comments, reason: `la sessione cloud è rimasta muta per ${minutes} minuti`, ...EMPTY };
      }
      if (!run.done) return { status: "in_progress", dispatchState: "working", dispatchError: null, comments, ...EMPTY };

      if (run.failed) {
        runs.delete(input.runId);
        forget(input.runId);
        comments.push({
          id: run.resultId ?? `result-${input.runId}`, author: "agent", kind: "delivery", createdAt: new Date().toISOString(),
          content: `La sessione cloud è finita con un errore${run.resultText ? `: ${run.resultText}` : "."}\n\nSessione: ${link}`,
        });
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_session_failed", comments, reason: "la sessione cloud è finita con un errore", ...EMPTY };
      }
      // Il ramo consegnato si guarda su origin: è lì che la sessione l'ha spinto.
      let branch: string | null = null;
      let commit: string | null = null;
      let unreachable = false;
      for (const b of [run.branch, run.publishedBranch].filter(Boolean) as string[]) {
        const sha = await remoteSha(run.originUrl, `refs/heads/${b}`);
        if (sha === undefined) { unreachable = true; continue; }
        if (sha) { branch = b; commit = sha; break; }
      }
      // Origin muto non vuol dire «ramo non spinto»: si riprova al prossimo giro, fino a 10.
      if (!branch && unreachable && ++run.originFails < ORIGIN_RETRIES) {
        return { status: "in_progress", dispatchState: "working", dispatchError: null, comments, ...EMPTY };
      }
      runs.delete(input.runId);
      forget(input.runId);
      comments.push({
        id: run.resultId ?? `result-${input.runId}`, author: "agent", kind: "delivery", createdAt: new Date().toISOString(),
        content: `${run.resultText || "Sessione cloud finita."}\n\nSessione: ${link}`,
      });
      if (!branch && unreachable) {
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_origin_unreachable", comments, reason: `origin non risponde, e il ramo \`${run.branch}\` non si è potuto cercare`, ...EMPTY };
      }
      if (!branch) {
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_no_branch", comments, reason: `la sessione non ha spinto il ramo \`${run.branch}\` su origin`, ...EMPTY };
      }
      try {
        run.bundle = await prepareBundle(run, branch);
        run.finished = true;
        runs.set(input.runId, run); // solo per fetchBundle, che arriva subito dopo
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_bundle_failed", comments, reason: `il ramo \`${branch}\` è su origin ma non si è potuto preparare qui (${why})`, ...EMPTY };
      }
      return { status: "review", dispatchState: "delivered", dispatchError: null, comments, deliveryBranch: branch, deliveryCommit: commit, baseSha: run.bundle.base, stat: null };
    },

    async fetchBundle(input: { runId: string }): Promise<BundleResult> {
      const run = runs.get(input.runId);
      runs.delete(input.runId);
      if (!run?.bundle) throw new Error("nessun bundle pronto per questa corsa");
      return run.bundle.result;
    },

    async cancelRun(input: { runId: string }): Promise<void> {
      if (input.runId.startsWith("refused-")) { runs.delete(input.runId); return; }
      // Una sessione già finita e consegnata non si tocca: la nota di consegna la linka, e
      // archiviarla perché la card torna indietro toglierebbe a chi rivede la sua storia.
      const live = runs.get(input.runId);
      if (live?.finished) { runs.delete(input.runId); return; }
      if (!live && !(input.runId in loadPersisted())) return;
      await stop(input.runId);
    },
  };
}

