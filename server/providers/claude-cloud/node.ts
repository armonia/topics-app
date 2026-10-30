// Claude's cloud as a NODE of the remote lane (KANBAN-76): a card with the «Cloud Claude»
// machine does not run here, it runs in a cloud session, and only the polling stays on this side.
// The lane (task-dispatcher-remote-node.ts) already does everything else: mirrors state and comments,
// plants the delivered branch, moves the card to review, requeues it after a restart.
// This file translates the four NodeDeps calls into those of the sessions API.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BundleResult, CreateRunBody, NodeRunComment, NodeRunReport } from "../../services/node-client";
import { CloudApi, CloudSetupError, cloudApiIsReal, type CloudEvent } from "./api";
import { isPermissionAsk } from "./events";
import { runBounded } from "../../lib/bounded-spawn";

/** The base_url of the cloud's `machines` row: not an address, a placeholder. */
export const CLOUD_NODE_BASE_URL = "claude-cloud://";
export const CLOUD_NODE_HOST = "claude-cloud";
export const CLOUD_NODE_NAME = "Cloud Claude";
/** The lane refuses a node without a token: for the cloud, authentication is the Claude Code login. */
export const CLOUD_NODE_TOKEN = "claude-cloud";

/**
 * Is the cloud reachable from this machine? Claude Code's own login in the Keychain, the
 * same credential `claude --cloud` uses. `TOPICS_CLAUDE_CLOUD=0` switches it off.
 */
export function cloudCredentialsPresent(): boolean {
  if (process.platform !== "darwin" || process.env.TOPICS_CLAUDE_CLOUD === "0") return false;
  // The test server does not read the login Keychain (test-server.ts): no cloud there.
  if (process.env.TOPICS_CREDENTIALS_KEYCHAIN === "0") return false;
  // Synchronous and once only, at boot (server.ts, providers/index.ts): decides whether the row exists.
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
/** Quality first: without an explicit Claude model on the card, Opus. */
export const CLOUD_DEFAULT_MODEL = "claude-opus-5-5";

/** «claude-code:sonnet», «sonnet», «claude-sonnet-5-5» → full id; a non-Claude model → default. */
export function cloudModelFor(selection: string | null | undefined): string {
  const raw = (selection ?? "").split(":").at(-1)!.trim().toLowerCase();
  if (MODEL_ALIASES[raw]) return MODEL_ALIASES[raw];
  return raw.startsWith("claude-") ? raw : CLOUD_DEFAULT_MODEL;
}

/**
 * «git@github.com:o/r.git», «https://github.com/o/r», «ssh://git@ssh.github.com:443/o/r.git»,
 * ssh alias «git@github.com-work:o/r» → «o/r». Any other host → null: the host is
 * compared whole, never as a substring (notgithub.com, github.com.evil.example, a local
 * path with «github.com» inside are other repos).
 */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);

/**
 * An ssh alias («github.com-work») is GitHub only if ~/.ssh/config takes it there: that is told by
 * `ssh -G`, which resolves without connecting. The name alone proves nothing
 * (`github.com-evil.com` is a real domain).
 */
async function sshAliasIsGithub(alias: string): Promise<boolean> {
  if (!/^[\w.-]+$/.test(alias)) return false;
  const r = await runBounded(["ssh", "-G", "--", alias], { stdout: "pipe", stderr: "ignore", timeoutMs: 5_000 });
  if (r.exitCode !== 0) return false;
  const host = r.stdout.match(/^hostname (\S+)$/m)?.[1]?.toLowerCase();
  return !!host && GITHUB_HOSTS.has(host);
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

/** Only GitHub hosts written in full; an ssh alias is not one (see `resolveGithubSlug`). */
export function githubSlug(originUrl: string): string | null {
  const o = parseOrigin(originUrl);
  return o && GITHUB_HOSTS.has(o.host) ? o.slug : null;
}

/** Like `githubSlug`, plus the ssh aliases that `ssh -G` resolves to GitHub. */
export async function resolveGithubSlug(originUrl: string): Promise<string | null> {
  const o = parseOrigin(originUrl);
  if (!o) return null;
  if (GITHUB_HOSTS.has(o.host)) return o.slug;
  return o.viaSsh && (await sshAliasIsGithub(o.host)) ? o.slug : null;
}

export type GitRun = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** An origin that does not answer must not stop the round of all remote cards: 60 s and move on. */
const GIT_TIMEOUT_MS = 60_000;
const realGit: GitRun = async (args, cwd) => {
  const r = await runBounded(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeoutMs: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.exitCode ?? 124, stdout: r.stdout, stderr: r.stderr || r.spawnError || (r.timedOut ? "timeout" : "") };
};

export interface CloudNodeDeps {
  api: CloudApi;
  /** The card's checkout, to build the bundle of the delivered branch. */
  repoPathOfTask: (taskId: string) => string | null;
  git?: GitRun;
  /** Silence after which an unfinished session is stalled (default 15 min). */
  stallMs?: number;
  now?: () => number;
  /**
   * Where live runs are kept between restarts. The lane remembers the last run only
   * in memory: after a restart it requeues the card and calls `createRun` without cancelling
   * anything. A paired node is idempotent on `originTaskId`; this file is so thanks to this.
   */
  statePath?: string;
}

interface CloudRun {
  taskId: string;
  originUrl: string;
  branch: string;
  cursor?: string;
  /** The lane "lures" the first report and does not write it: the first one stays empty on purpose. */
  reported: boolean;
  done: boolean;
  failed: boolean;
  resultText: string;
  resultId?: string;
  /** Branches the session itself says it pushed, in the order it pushed them. */
  pushedBranches: string[];
  asks: Map<string, { tool: string; answered: boolean }>;
  lastEventAt: number;
  /** Consecutive rounds in which origin did not answer the delivered-branch lookup. */
  originFails: number;
  /** A card the cloud cannot take: it closes in review with the reason, without a session. */
  refused?: string;
  /** The session is finished and delivered: a cancel afterwards must not archive it. */
  finished?: boolean;
  /** The ready bundle, computed when the session finishes (base = what the checkout already has). */
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
    // The cloud harness may force its own name or a suffix on a session's branch (ff0bb951): that one
    // wins. What counts is that it reaches origin, because work left only in the VM is lost (b5ab4b4c).
    "Se la tua sessione ti impone un altro nome di ramo, o un suffisso, usa quello. In ogni caso, prima di chiudere, fai push del ramo con `git push -u origin HEAD`: il lavoro che resta solo nella sessione si perde.",
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
    return { ...p, reported: false, done: false, failed: false, resultText: "", pushedBranches: [], asks: new Map(), lastEventAt: now(), originFails: 0 };
  }

  /** `undefined` = origin did not answer (retry), `null` = the branch is not there. */
  async function remoteSha(originUrl: string, ref: string): Promise<string | null | undefined> {
    const r = await git(["ls-remote", originUrl, ref]);
    if (r.code !== 0) return undefined;
    return r.stdout.split(/\s+/)[0] || null;
  }

  /**
   * The branches on origin named like the one we asked for plus a suffix (`<branch>-<anything>`).
   * The cloud harness appends its own to the branch of a session, so the bare name never exists.
   * Each comes with its tip, from the SAME answer: asking again for the sha would leave a gap in which a
   * mute origin reads as «branch not pushed». `undefined` = origin did not answer, `[]` = none. Sorted by
   * name, so a card with two suffixed branches always resolves to the same one.
   */
  async function suffixedBranches(originUrl: string, branch: string): Promise<Array<{ name: string; sha: string }> | undefined> {
    const r = await git(["ls-remote", originUrl, `refs/heads/${branch}-*`]);
    if (r.code !== 0) return undefined;
    const prefix = "refs/heads/";
    return r.stdout.split("\n")
      .map((l) => l.split(/\s+/))
      .filter(([sha, ref]) => !!sha && !!ref && ref.startsWith(prefix))
      .map(([sha, ref]) => ({ name: ref!.slice(prefix.length), sha: sha! }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async function defaultBranch(originUrl: string): Promise<string> {
    const r = await git(["ls-remote", "--symref", originUrl, "HEAD"]);
    return r.stdout.match(/ref: refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? "main";
  }

  /** Stops the session and stops following it. Best effort: the API does not say whether it stopped. */
  async function stop(sid: string) {
    runs.delete(sid);
    forget(sid);
    try { await deps.api.stopSession(sid); } catch { /* already closed */ }
  }

  /**
   * The bundle of the delivered branch, against a commit the checkout ALREADY has: the base is the
   * merge-base between the branch tip and the checkout's HEAD, not origin's HEAD at launch
   * (a checkout behind origin would not have it, and the plumbing would refuse).
   * Temporary bare repo with the checkout's objects borrowed: the checkout is left untouched.
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
    } else if (
      ev.type === "system" && typeof ev.branch === "string" &&
      (ev.subtype === "code_change_published" || (ev.subtype === "vcs_state_changed" && ev.kind === "push"))
    ) {
      // `vcs_state_changed` with kind «push» is what a real session emits (measured on ff0bb951);
      // `code_change_published` is the older name this file already knew.
      if (!run.pushedBranches.includes(ev.branch)) run.pushedBranches.push(ev.branch);
    } else if (isPermissionAsk(ev) && typeof ev.request_id === "string") {
      const req = (ev.request ?? {}) as { tool_name?: string };
      run.asks.set(ev.request_id, { tool: req.tool_name ?? "tool", answered: false });
    } else if (ev.type === "control_cancel_request" && typeof ev.request_id === "string") {
      // The session withdrew the question: it is no longer waiting for anyone.
      const a = run.asks.get(ev.request_id);
      if (a) a.answered = true;
    } else if (ev.type === "control_response") {
      const id = (ev.response as { request_id?: string } | undefined)?.request_id;
      const a = id ? run.asks.get(id) : undefined;
      if (a) a.answered = true;
    }
  }

  // DOES THIS ACCOUNT HAVE AN ACTIVE CLOUD ENVIRONMENT? `null` = not asked yet,
  // or the last question got no answer (network): only a definite answer moves it.
  // The heartbeat reads it (`environmentReady`): without one the cloud row is not
  // online, and the overflow does not send cards there.
  let envReady: { ok: boolean; reason: string } | null = null;
  let envAskedAt = -Infinity;
  let envAsking: Promise<void> | null = null;
  /** The environment id, or a `CloudSetupError` (the lane parks the card with its words). */
  async function environmentId(): Promise<string> {
    try {
      const id = await deps.api.defaultEnvironmentId();
      envReady = { ok: true, reason: "" };
      return id;
    } catch (err) {
      if (err instanceof CloudSetupError) envReady = { ok: false, reason: err.message };
      throw err;
    } finally { envAskedAt = now(); }
  }

  const note = (id: string, content: string): NodeRunComment =>
    ({ id, author: "system", kind: "service", createdAt: new Date().toISOString(), content });

  return {
    /** The last definite answer on the account's cloud environment: `null` = none yet. */
    environmentReady(): { ok: boolean; reason: string } | null {
      return envReady;
    },
    /** Ask again, at most every `everyMs`: the heartbeat calls it on every beat. */
    probeEnvironment(everyMs = 5 * 60_000): Promise<void> {
      if (envAsking) return envAsking;
      if (now() - envAskedAt < everyMs) return Promise.resolve();
      envAsking = environmentId().then(() => {}, () => {}).finally(() => { envAsking = null; });
      return envAsking;
    },

    async createRun(input: { body: CreateRunBody }): Promise<{ runId: string }> {
      const { body } = input;
      // After a restart the lane relaunches the same card: the live session is resumed.
      for (const [sid, p] of Object.entries(loadPersisted())) {
        if (p.taskId !== body.originTaskId) continue;
        if (!runs.has(sid)) runs.set(sid, newRun(p));
        return { runId: sid };
      }
      const slug = await resolveGithubSlug(body.originUrl);
      // Outside GitHub the cloud session cannot clone (the e2e suite's fake can). This is not
      // a mute node to retry: the card goes to review with the reason.
      if (!slug && cloudApiIsReal()) {
        const sid = `refused-${crypto.randomUUID()}`;
        runs.set(sid, { ...newRun({ taskId: body.originTaskId, originUrl: body.originUrl, branch: "" }), refused: `il cloud di Claude clona solo da GitHub, e l'origin di questo progetto è ${body.originUrl}` });
        return { runId: sid };
      }
      // The account first: without an active environment nothing can start, and the error is a
      // `CloudSetupError` the lane parks the card with, not a silent node it retries for half an hour.
      const environment = await environmentId();
      // A card that already has a branch starts from it, not from main: started from main, the
      // delivery lacked that branch's commits and conflicted with them at the land (df5fd8c5).
      const revision = body.baseBranch?.trim() || await defaultBranch(body.originUrl);
      const branch = `claude/card-${body.originTaskId.slice(0, 8)}-${crypto.randomUUID().slice(0, 4)}`;
      const sid = await deps.api.createSession({
        title: body.text.slice(0, 60),
        prompt: prompt(body, branch, revision),
        source: { repo: slug ?? body.originUrl, revision },
        deliveryBranch: branch,
        model: cloudModelFor(body.model),
        effort: body.effort ?? undefined,
        environmentId: environment,
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

      // A paused VM or a polling that no longer sees anything: the card is stalled, never delivered.
      // An open question is not silence: the session is waiting for a person, it is not stalled.
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
      // The delivered branch is looked up on origin: that is where the session pushed it.
      let branch: string | null = null;
      let commit: string | null = null;
      let unreachable = false;
      let ambiguous: string[] = [];
      // What the session itself says it pushed (the latest first) outranks the name we asked for.
      for (const b of [...new Set([...run.pushedBranches].reverse().concat(run.branch))].filter(Boolean)) {
        const sha = await remoteSha(run.originUrl, `refs/heads/${b}`);
        if (sha === undefined) { unreachable = true; continue; }
        if (sha) { branch = b; commit = sha; break; }
      }
      // Neither a declared push nor the asked-for name exists: the harness may have suffixed it.
      if (!branch && !unreachable && run.branch) {
        const found = await suffixedBranches(run.originUrl, run.branch);
        if (found === undefined) unreachable = true;
        // Several branches under one prefix: picking one would deliver somebody else's work, a person decides.
        else if (found.length === 1) { branch = found[0]!.name; commit = found[0]!.sha; }
        else ambiguous = found.map((f) => f.name);
      }
      // A mute origin does not mean «branch not pushed»: retry on the next round, up to 10.
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
        return { status: "review", dispatchState: "needs_input", dispatchError: "cloud_no_branch", comments, reason: ambiguous.length
          ? `la sessione ha spinto più rami che iniziano per \`${run.branch}-\` (${ambiguous.map((b) => `\`${b}\``).join(", ")}): non ne scelgo uno io`
          : `la sessione non ha spinto il ramo \`${run.branch}\` su origin`, ...EMPTY };
      }
      try {
        run.bundle = await prepareBundle(run, branch);
        run.finished = true;
        runs.set(input.runId, run); // only for fetchBundle, which comes right after
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
      // A session already finished and delivered is not touched: the delivery note links it, and
      // archiving it because the card goes back would take its history away from whoever reviews.
      const live = runs.get(input.runId);
      if (live?.finished) { runs.delete(input.runId); return; }
      if (!live && !(input.runId in loadPersisted())) return;
      await stop(input.runId);
    },
  };
}

