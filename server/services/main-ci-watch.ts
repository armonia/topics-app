/**
 * THE CI OF MAIN, WATCHED FOR WHAT NO CARD OWNS.
 *
 * The `after` rule of the CI phase measures what a card landed, and sends the red back to that card. A commit
 * that reached main without one (a chat that pushed, a hand-made fix, «Landa e pubblica», a card dragged to
 * Done) has nobody to send a red to: the push CI of main goes red and the board says nothing. Measured on
 * 16-17/11: main stayed red for hours on two such commits, and a chat archived before the red cannot be woken
 * (it is what the work launched before the archive is, PR #1195).
 *
 * So the board looks at main itself: the newest commit of main whose push CI has an answer. Green: nothing.
 * Red: if a card of the `after` rule is already on it, that card is told by its own measure; otherwise ONE
 * card is opened for the sha, and the dispatcher takes it like any other. Pending: ask again next sweep.
 *
 * Pure on purpose: git, GitHub and the board are the caller's (`MainCiPort`, `MainCiWatchDeps`).
 */
import { CI_CONFIG_PATH, spawnCapped, githubPort } from "./ci-evidence";
import { runGit } from "../lib/run-git";

export type MainCiState = "pass" | "fail" | "pending" | "none";

export interface MainCiVerdict {
  state: MainCiState;
  /** The jobs that failed, by name. */
  failed: string[];
  /** The run the verdict is read from. */
  url: string | null;
}

export interface MainCiCommit { sha: string; subject: string; /** Unix seconds. */ at: number }

/** What the watch needs to know about one repository's main. */
export interface MainCiPort {
  /** The latest commits of main, first-parent, newest first. */
  recent(): Promise<MainCiCommit[]>;
  /** What the CI of the PUSH of `sha` said. */
  verdict(sha: string): Promise<MainCiVerdict>;
  /** `commit` came into main with `sha` and not before: that push is the one that carried it. */
  entersAt(commit: string, sha: string): Promise<boolean>;
}

export interface MainCiWatchDeps {
  port: MainCiPort;
  /** A card of the `after` rule is working on this red already. */
  owned(sha: string, port: MainCiPort): Promise<boolean>;
  /** Opens the card for `sha`; `false` = one exists already (the key is the sha, archived or done included). */
  open(commit: MainCiCommit, verdict: MainCiVerdict): boolean;
  now?: () => number;
}

export type MainCiOutcome = "no-ci" | "pending" | "green" | "owned" | "exists" | "opened";

/** A commit this young may simply not have its run listed yet: that is "pending", not "no CI". */
export const RUN_APPEARS_WITHIN_S = 10 * 60;

/** Looks at the newest commit of main that has an answer; acts only on a red. */
export async function watchMainCi(deps: MainCiWatchDeps): Promise<MainCiOutcome> {
  const now = (deps.now ?? Date.now)() / 1000;
  const commits = await deps.port.recent();
  for (const c of commits) {
    const v = await deps.port.verdict(c.sha);
    if (v.state === "pending") return "pending";
    if (v.state === "none") {
      if (now - c.at < RUN_APPEARS_WITHIN_S) return "pending";
      continue; // no CI ran for this commit (a change the workflow skips): the one before it speaks
    }
    if (v.state === "pass") return "green";
    if (await deps.owned(c.sha, deps.port)) return "owned";
    return deps.open(c, v) ? "opened" : "exists";
  }
  return "no-ci";
}

/**
 * Why a land must wait: the newest commit of main that has an answer is red. A land on a red main proves nothing
 * (its own CI inherits the red) and every card in review then inherits it too. Pending, unknown and no-CI never
 * stop a land: a guess is not a refusal. Null = go ahead.
 */
export async function mainRedStop(port: MainCiPort, nowMs: number = Date.now()): Promise<string | null> {
  const commits = await port.recent();
  for (const c of commits) {
    const v = await port.verdict(c.sha);
    if (v.state === "pending") return null;
    if (v.state === "none") {
      if (nowMs / 1000 - c.at < RUN_APPEARS_WITHIN_S) return null;
      continue;
    }
    if (v.state === "pass") return null;
    const jobs = v.failed.length ? ` (${v.failed.join(", ")})` : "";
    return `the CI of main is red on ${c.sha.slice(0, 8)}${jobs}: landing on a red main proves nothing, so the land waits for the repair${v.url ? ` (${v.url})` : ""}`;
  }
  return null;
}

/** The model every red-main card runs on: the repair is a recipe, not research. */
export const MAIN_RED_MODEL = "claude-sonnet-5-5";

/** The run id at the end of a GitHub run URL, or a placeholder when the URL has none. */
const runId = (url: string): string => /\/runs\/(\d+)/.exec(url)?.[1] ?? "<id>";

/** The failing jobs and the run, as the card reads them. */
export function describeMainRed(c: MainCiCommit, v: MainCiVerdict): string {
  return [
    `La CI del push su main è rossa sul commit \`${c.sha}\` («${c.subject}»).`,
    v.failed.length ? `Job rossi: ${v.failed.map((n) => `\`${n}\``).join(", ")}.` : "Nessun job rosso nominato: apri il run.",
    v.url ? `Run: ${v.url}` : "",
    "Nessuna card atterrata ha questo commit sotto la sua misura: è arrivato su main da una chat o a mano. " +
      "Ricetta fissa, parti da qui senza esplorare: " +
      "1) `git fetch origin main` e `git merge --ff-only origin/main` nel tuo worktree; " +
      (v.url ? `2) il log del run rosso: \`gh run view ${runId(v.url)} --log-failed\`; ` : "2) il log del run rosso: `gh run view <id> --log-failed`; ") +
      "3) ripara IN AVANTI con un commit nuovo su main (niente revert, niente force), " +
      "consegna e la card si chiude con la CI verde.",
  ].filter(Boolean).join("\n\n");
}

/** The title says what is red and where, in words. */
export const mainRedTitle = (sha: string): string => `CI rossa su main dopo ${sha.slice(0, 8)}: riparare`;

/** The dedupe key of a sha: a second sweep finds the card it opened. */
export const mainRedKey = (projectId: string, sha: string): string => `main-ci-red:${projectId}:${sha}`;

/** The shared start of every `mainRedKey` of a project: the way to find the red card that is still open. */
export const mainRedKeyPrefix = (projectId: string): string => `main-ci-red:${projectId}:`;

/**
 * The line a still-open red card receives when main goes red again on another sha: the new commit, the jobs
 * and the run, so the repair on that card reads the whole story instead of a second card repeating it. The
 * sha is in the words on purpose: that is what keeps a sweep from writing the same line twice.
 */
export function describeMainRedAgain(c: MainCiCommit, v: MainCiVerdict): string {
  return [
    `La CI di main è rossa anche sul commit \`${c.sha}\` («${c.subject}»), mentre questa card è ancora aperta.`,
    v.failed.length ? `Job rossi: ${v.failed.map((n) => `\`${n}\``).join(", ")}.` : "",
    v.url ? `Run: ${v.url}` : "",
    "Non apro un'altra card: la riparazione di questa copre anche il nuovo commit.",
  ].filter(Boolean).join(" ");
}

/** The real port: git for the commits, `gh` for the push runs of ci.yml. */
export function realMainCiPort(repoPath: string): MainCiPort {
  const git = (args: string[]) => runGit(repoPath, args, { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  let repoName: string | null = null;
  const repo = async (): Promise<string | null> => {
    if (repoName) return repoName;
    const got = await githubPort().repo(repoPath);
    repoName = got.ok ? got.value : null;
    return repoName;
  };
  const api = async (path: string): Promise<unknown | null> => {
    const r = await spawnCapped(["gh", "api", path], repoPath);
    if (r.code !== 0) return null;
    try { return JSON.parse(r.out); } catch { return null; }
  };
  return {
    async recent() {
      await git(["fetch", "--quiet", "origin", "main"]); // a failed fetch reads the copy this machine has: stale, never wrong
      const r = await git(["log", "--first-parent", "-n", "10", "--since=24 hours ago", "--format=%H%x09%ct%x09%s", "origin/main"]);
      if (r.code !== 0) return [];
      return r.stdout.split("\n").filter(Boolean).map((l) => {
        const [sha = "", at = "0", ...subject] = l.split("\t");
        return { sha, at: Number(at) || 0, subject: subject.join("\t") };
      });
    },
    async verdict(sha) {
      const name = await repo();
      const none: MainCiVerdict = { state: "none", failed: [], url: null };
      if (!name) return { ...none, state: "pending" }; // GitHub unreachable: not an answer, ask again
      const listed = await api(`repos/${name}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=20`) as { workflow_runs?: Array<Record<string, unknown>> } | null;
      if (!listed) return { ...none, state: "pending" };
      const runs = (listed.workflow_runs ?? []).filter((r) => typeof r.path === "string"
        && (r.path === CI_CONFIG_PATH || r.path.startsWith(`${CI_CONFIG_PATH}@`)));
      const run = runs.reduce<Record<string, unknown> | null>((best, r) => (!best || Number(r.id) > Number(best.id) ? r : best), null);
      if (!run) return none;
      const url = typeof run.html_url === "string" ? run.html_url : null;
      if (run.status !== "completed") return { state: "pending", failed: [], url };
      if (run.conclusion === "success") return { state: "pass", failed: [], url };
      if (run.conclusion !== "failure" && run.conclusion !== "timed_out") return { state: "none", failed: [], url }; // cancelled or skipped: no verdict
      const jobs = await api(`repos/${name}/actions/runs/${String(run.id)}/jobs?filter=latest&per_page=100`) as { jobs?: Array<{ name?: string; conclusion?: string | null }> } | null;
      const failed = (jobs?.jobs ?? []).filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out").map((j) => String(j.name));
      return { state: "fail", failed, url };
    },
    async entersAt(commit, sha) {
      // Exit 1 is "no"; a commit this clone does not have (128) is "not this one" too: no card is held back by a guess.
      const inSha = await git(["merge-base", "--is-ancestor", commit, sha]);
      if (inSha.code !== 0) return false;
      const before = await git(["merge-base", "--is-ancestor", commit, `${sha}^1`]);
      return before.code === 1;
    },
  };
}
