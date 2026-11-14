/**
 * Deploy and publish of a landed task: the proposal, the run and the push to origin.
 */
import { SPAWN_TIMEOUT, runBounded } from "../lib/bounded-spawn";
import { projectIdForPath, type Task } from "../services/tasks";
import { runGitCap } from "./tasks-git";
import type { TasksCore } from "./tasks-scope";

export function createTasksDeploy(core: TasksCore) {
  const { opts, svc, broadcastToAll } = core;

  /**
   * Post-approve: PROPOSE a deploy, never run one. Mirrors `enqueueLandOnDone`'s
   * shape (a board setting gates an approve-time side effect) but the effect
   * itself stops one step earlier — a comment + a button, not a queued action.
   * No-op when the board has no `deployCommand` configured.
   */
  function proposeDeployIfConfigured(projectId: string, taskId: string): void {
    let cmd = "";
    try { cmd = (svc.getBoardSettings(projectId).deployCommand ?? "").trim(); }
    catch (err) { console.warn("[deploy] board settings unreadable for", projectId, err); return; }
    if (!cmd) return;
    try {
      const proposed = svc.proposeDeploy({ taskId, command: cmd });
      if (proposed) broadcastToAll({ type: "task:updated", projectId, task: proposed });
    } catch (err) { console.warn("[deploy] propose failed for", taskId, err); }
  }

  /**
   * Runs a CONFIRMED deploy in the project's own checkout (never a worktree —
   * the whole point is "the real thing", same target as `publishProject`).
   * Fire-and-forget from the route: the request already answered 202 with the
   * task in `running`; the outcome lands as a system comment + broadcast.
   */
  async function runDeploy(projectId: string, taskId: string, command: string): Promise<void> {
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    const cwd = dirs.find((d) => projectIdForPath(d) === projectId);
    const settle = (ok: boolean, detail: string) => {
      let t: Task;
      try { t = svc.finishDeploy({ taskId, ok, detail }); }
      catch (err) { console.warn("[deploy] finish failed for", taskId, err); return; }
      broadcastToAll({ type: "task:updated", projectId, task: t });
    };
    if (!cwd) { settle(false, "progetto non risolvibile su questo host: nessun checkout da usare."); return; }
    // 10 minutes: a deploy that does not return within this window is a stuck
    // deploy, not a slow one — better to say so than stay "running" forever.
    // A real deadline (`runBounded`) and not a `setTimeout` + `kill()`: the shell's
    // children kept the pipe open after the kill and the deploy stayed "running" regardless.
    const r = await runBounded(["bash", "-lc", command], {
      cwd, stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 10 * 60 * 1000,
    });
    if (r.spawnFailed) { settle(false, `\`${command}\`: ${r.spawnError ?? ""}`); return; }
    const code = r.exitCode ?? 124;
    const tail = (s: string) => s.trim().slice(-1500);
    const body = tail(r.stderr) || tail(r.stdout);
    const detail = `\`${command}\` (exit ${code})` + (body ? `\n\n\`\`\`\n${body}\n\`\`\`` : "");
    settle(code === 0, detail);
  }

  /** Push a project's current branch to origin (triggers deploy CI where set up).
   *  Shared by the /publish endpoint and the agent-proposed "Landa e pubblica"
   *  option. Never resolves an unknown project — returns {ok:false}. */
  async function publishProject(projectId: string): Promise<{ ok: boolean; branch?: string; output?: string; error?: string; code?: string }> {
    let dirs: string[] = [];
    try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
    const path = dirs.find((d) => projectIdForPath(d) === projectId);
    if (!path) return { ok: false, error: "project not found", code: "not_found" };
    const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
    if (!branch) return { ok: false, error: "detached HEAD: nothing to publish.", code: "detached_head" };
    // 10 minutes: a pre-push hook (tests, lint) may run for minutes, and this push had
    // no deadline at all before T5. 120 s would turn a slow hook into a failed publish.
    const push = await runGitCap(path, ["push", "origin", branch], SPAWN_TIMEOUT.long);
    if (push.code !== 0) return { ok: false, branch, error: (push.err || push.out).trim().slice(-400) || "git push fallito" };
    return { ok: true, branch, output: (push.err + "\n" + push.out).trim().slice(-400) };
  }

  return { proposeDeployIfConfigured, runDeploy, publishProject };
}
