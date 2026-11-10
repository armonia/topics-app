/**
 * MAIN, ON ORIGIN AFTER EVERY LAND.
 *
 * The land merges into the LOCAL `main` and, by design, never pushed: the
 * header of `task-automerge.ts` left that to "the release pipeline", which
 * does not exist. Measured 10/11/2026: the live checkout was 18 commits ahead
 * of origin (cards a9281987, 41036ba9, 57fe1061, 895ff2f8 and others in Done,
 * none of them on GitHub), and the same had happened at 00:40 with 0fee0f07.
 * A card in Done whose work is only on this disk is a card nobody else sees,
 * and the next PR merged on GitHub makes the two mains diverge.
 *
 * So `main` goes to origin right after the land, fast-forward ONLY: a plain
 * push (never forced) of `refs/heads/main`. If origin moved on its own and the
 * two diverged, git refuses and we say so; nothing is rewritten.
 */
import { runBounded, SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import type { GitRunner } from "./own-commits";

export type MainPush =
  | { ok: true; pushed: number }
  | { ok: false; reason: string };

/** Bounded git without prompts; two minutes for the push: it runs inside the land queue, and a hung one must not stall every card behind it. */
export const mainPushGit: GitRunner = async (cwd, args) => {
  const isPush = args[0] === "push";
  const r = await runBounded(["git", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe",
    timeoutMs: isPush ? SPAWN_TIMEOUT.write : SPAWN_TIMEOUT.query,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.spawnFailed) return { code: 1, stdout: "", stderr: r.spawnError ?? "" };
  return { code: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr || (r.timedOut ? "timeout" : "") };
};

const tail = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/**
 * Push local `branch` to origin if (and only if) it is a fast-forward of
 * `origin/<branch>`. A repo without `origin`, or whose origin has no such
 * branch, is not ours to publish: `{ok:true, pushed:0}`.
 */
export async function pushMainToOrigin(repoPath: string, run: GitRunner = mainPushGit, branch = "main"): Promise<MainPush> {
  const remote = await run(repoPath, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) return { ok: true, pushed: 0 };
  const fetch = await run(repoPath, ["fetch", "--no-tags", "-q", "origin", branch]);
  if (fetch.code !== 0) return { ok: false, reason: `fetch di origin/${branch} fallito: ${tail(fetch.stderr ?? "") || "nessun motivo"}` };
  const ahead = await run(repoPath, ["rev-list", "--count", `refs/remotes/origin/${branch}..refs/heads/${branch}`]);
  if (ahead.code !== 0) return { ok: true, pushed: 0 };
  const n = Number.parseInt(ahead.stdout.trim(), 10) || 0;
  if (n === 0) return { ok: true, pushed: 0 };
  const ff = await run(repoPath, ["merge-base", "--is-ancestor", `refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
  if (ff.code !== 0) {
    return { ok: false, reason: `${branch} locale e origin/${branch} hanno storie divergenti: niente push (solo fast-forward)` };
  }
  const push = await run(repoPath, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
  if (push.code !== 0) return { ok: false, reason: `git push fallito: ${tail(push.stderr || push.stdout || "") || "nessun motivo"}` };
  return { ok: true, pushed: n };
}

/**
 * The periodic half: every land that stayed behind (push timed out, network
 * down, origin diverged and then realigned) is pushed again, fast-forward
 * only. `onPushed` lets the caller turn the cards' `unpushed` into `landed`.
 */
export async function sweepUnpushedMains(
  repos: string[],
  onPushed: (repoPath: string, n: number) => void,
  run: GitRunner = mainPushGit,
): Promise<Array<{ repo: string; result: MainPush }>> {
  const out: Array<{ repo: string; result: MainPush }> = [];
  for (const repo of repos) {
    let result: MainPush;
    try { result = await pushMainToOrigin(repo, run); }
    catch (e) { result = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
    if (result.ok) onPushed(repo, result.pushed);
    out.push({ repo, result });
  }
  return out;
}
