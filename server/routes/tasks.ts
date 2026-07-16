/**
 * tasks.ts (route) — session-scoped task API for the MCP/agent surface.
 *
 * Rebuilds the task endpoints removed with the Master/Board subsystem
 * (commits 42e92c1d + 827f6b6e), but session-scoped instead of
 * `/api/projects/:id/...` or `/api/boards/...`: the caller is a Claude session
 * (`--session-key`), so the server derives the project AND the agent identity
 * from it — the agent never passes (or can spoof) a project id or author.
 *
 * Two surfaces, one service (server/services/tasks.ts):
 *   - `/api/sessions/:key/...` — the AGENT surface (MCP). actor="agent": can
 *     reach `review` but never `done` (the human review gate). Project + author
 *     are derived from the session key, never passed by the caller.
 *   - `/api/boards/:projectId/...` — the HUMAN board surface (the board UI).
 *     actor="human": may move to `done`, archive, and approve/reject reviews.
 *
 * Both go through the service's projectId guard, so a caller can only touch
 * tasks on the project it named/owns (no cross-project IDOR).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { getTerminalSessionById } from "./terminal";
import { AUTO_PROJECT_ID, createTaskService, projectIdForPath, TaskServiceError, UNASSIGNED_PROJECT_ID } from "../services/tasks";
import { computeDispatchCapacity } from "../services/dispatch-capacity";
import type { TaskDispatcher } from "../services/task-dispatcher";
import type { TaskAutoMerge } from "../services/task-automerge";

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_input: 400,
  invalid_transition: 400,
  agent_cannot_complete: 409,
  open_subtasks: 409,
  review_needs_summary: 409,
};

/**
 * Cap for AGENT-authored comments (the session surface only — humans are
 * uncapped). Generous enough for 2-3 dense sentences or a question block,
 * tight enough to reject log dumps; the 400 message coaches a retry.
 */
const AGENT_COMMENT_MAX_CHARS = 600;

export interface TasksRouterOpts {
  /** All project dirs the server knows (same union the dispatcher resolves against). */
  listProjectDirs?: () => string[];
  /** Workspace root for scaffolding a NEW project from the board. */
  workspaceDir?: string;
  /** Abort a running headless turn (human "stop" on a dispatched task). */
  abortTurn?: (sessionKey: string) => Promise<void>;
  /**
   * Auto-merge a task's worktree branch into main on approve (opt-in per board via
   * `dispatchAutoMerge`). Absent ⇒ approve never touches git.
   */
  autoMerge?: TaskAutoMerge;
}

/**
 * Run git in `cwd`, capturing stdout/stderr/exit. Never throws (code 1 on spawn
 * failure) and disables the credential prompt so a push that needs auth fails
 * fast instead of hanging the request.
 */
async function runGitCap(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code, out, err };
  } catch (e) {
    return { code: 1, out: "", err: String((e as Error)?.message ?? e) };
  }
}

/** Payload cap for a diff patch (~200 KB): a huge range renders the first slice
 *  and flags `truncated` so the UI shows a "…troncato" note rather than shipping
 *  megabytes into the client. */
const DIFF_PATCH_CAP = 200_000;

/**
 * Build a unified-diff bundle for `range` (any `git diff` selector — a `a..b`
 * range for a publish, or a base sha for a worktree). Returns the per-file stat
 * (additions/deletions/status, -1 count = binary) and the raw unified patch,
 * capped. Reuses `runGitCap`; never throws.
 */
async function gitDiffBundle(cwd: string, range: string): Promise<{
  stat: { path: string; additions: number; deletions: number; status: string }[];
  patch: string;
  truncated: boolean;
}> {
  const [numstat, nameStatus] = await Promise.all([
    runGitCap(cwd, ["diff", "--numstat", range]).then((r) => r.out),
    runGitCap(cwd, ["diff", "--name-status", range]).then((r) => r.out),
  ]);
  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const p = parts[parts.length - 1] ?? ""; // rename: status\told\tnew → take new
    if (p) statusByPath.set(p, (parts[0] ?? "M")[0] ?? "M");
  }
  const stat = numstat.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const add = parts[0] ?? "0";
    const del = parts[1] ?? "0";
    const path = parts[parts.length - 1] ?? "";
    return {
      path,
      additions: add === "-" ? -1 : Number.parseInt(add, 10) || 0,
      deletions: del === "-" ? -1 : Number.parseInt(del, 10) || 0,
      status: statusByPath.get(path) ?? "M",
    };
  });
  const full = (await runGitCap(cwd, ["diff", range])).out;
  const truncated = full.length > DIFF_PATCH_CAP;
  return { stat, patch: truncated ? full.slice(0, DIFF_PATCH_CAP) : full, truncated };
}

export function createTasksRouter(ctx: AppContext, dispatcher?: TaskDispatcher, opts?: TasksRouterOpts): RouteHandler {
  const { db, json, readJSON, matchRoute, broadcastToAll, getTopicBySessionKey, isPathAllowed } = ctx;
  const svc = createTaskService(db);

  /**
   * SECURITY: attachment paths are stored AND later handed to the agent as
   * "read these files" — so they must pass the same allowlist that gates
   * serving them (/api/media: uploads, context, workspace/media dirs). Without
   * this, a comment could reference ~/.ssh/id_rsa and the resume message would
   * happily instruct the agent to read it. Anything outside the allowlist is
   * silently dropped (the comment itself still lands).
   */
  function filterMedia(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((m): m is string => {
      if (typeof m !== "string" || !m.startsWith("/")) return false;
      if (typeof isPathAllowed !== "function") return true; // test ctx without the helper
      try { return isPathAllowed(m); } catch { return false; }
    });
  }

  /**
   * Resolve the board project id + a display author from a session key. Works
   * for BOTH a chat topic bound to a project and a Claude terminal tab (which
   * has a cwd but no chat topic). Returns null when the session is unbound.
   * `topicId` (chat sessions only) feeds the "own steps" carve-out: it lets the
   * service recognise subtasks of the task dispatched to THIS agent.
   */
  function resolveSession(sessionKey: string): { projectId: string; author: string; topicId: string | null } | null {
    const topic = getTopicBySessionKey(sessionKey);
    if (topic?.projectPath) {
      // A dispatched agent's board is the board of the task bound to its topic,
      // NOT the topic's cwd: a catch-all ("generale") task runs in a per-task
      // private dir (~/.openclaw/workspace/tasks/<id8>) that maps to no real
      // board, so cwd-derived scoping 404s every one of the agent's own task
      // ops. When the topic carries a bound task, scope to THAT board.
      const boundProject = topic.id ? svc.boardProjectForTopic(topic.id) : null;
      const projectId = boundProject ?? projectIdForPath(topic.projectPath);
      return { projectId, author: topic.name?.trim() || "claude", topicId: topic.id ?? null };
    }
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) {
      return { projectId: projectIdForPath(term.cwd), author: (term.name || "").trim() || "claude", topicId: null };
    }
    return null;
  }

  function fail(e: unknown): Response {
    if (e instanceof TaskServiceError) return json({ error: e.message, code: e.code }, ERROR_STATUS[e.code] ?? 400);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  return async function tasksRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    // Fast reject: only task paths — agent (session-scoped) or human (board-scoped),
    // plus the machine-wide dispatch-capacity probe (a /api/system/ path that this
    // router owns because it reads the same dispatch config).
    const isSession = pathname.startsWith("/api/sessions/");
    const isBoard = pathname.startsWith("/api/boards/");
    const isAllBoards = pathname.startsWith("/api/all-boards/");
    const isCapacity = pathname === "/api/system/dispatch-capacity";
    if (!isSession && !isBoard && !isAllBoards && !isCapacity) return null;

    // GET /api/all-boards/tasks — the global cross-project feed (human overview).
    // Read-only: per-task mutations still go to /api/boards/:projectId/... using
    // each task's own projectId.
    if (pathname === "/api/all-boards/tasks" && method === "GET") {
      const status = new URL(req.url).searchParams.get("status") || undefined;
      // Columns show ROOT tasks only — steps live in the parent's detail tree.
      try { return json({ tasks: svc.list({ scope: "all", status: status as any, rootsOnly: true }) }); }
      catch (e) { return fail(e); }
    }

    // GET /api/system/dispatch-capacity — the auto concurrency cap this machine
    // can sustain right now (CPU/load), shown in the board settings' "Auto" option.
    if (pathname === "/api/system/dispatch-capacity" && method === "GET") {
      return json(computeDispatchCapacity());
    }

    // GET /api/all-boards/publish-status — per-project "commits not yet pushed"
    // summary that feeds the board's Publish control (primarily the GLOBAL board,
    // where every project shows up together). Best-effort git, never throws.
    if (pathname === "/api/all-boards/publish-status" && method === "GET") {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
      const projects = (await Promise.all(dirs.map(async (path) => {
        const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
        const remotes = (await runGitCap(path, ["remote"])).out.trim();
        if (!branch || !remotes) return null; // detached HEAD or no remote → not publishable
        const upstream = (await runGitCap(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).out.trim();
        const range = upstream && !upstream.includes("fatal") ? `${upstream}..HEAD` : `origin/${branch}..HEAD`;
        const aheadRaw = (await runGitCap(path, ["rev-list", "--count", range])).out.trim();
        const ahead = Number.parseInt(aheadRaw || "0", 10);
        // The actual commit list that a push would ship — so the UI can show WHAT
        // goes out (subject + author + short hash) instead of a blind count, and
        // the human can spot a wrong-project / un-approved commit before pushing.
        // %x1f = unit separator (safe field delimiter); one commit per line, newest first.
        let commits: { hash: string; subject: string; author: string; when: string }[] = [];
        if (ahead > 0) {
          const logRaw = (await runGitCap(path, ["log", range, "--pretty=format:%h%x1f%s%x1f%an%x1f%ar", "--max-count=50"])).out;
          commits = logRaw.split("\n").filter(Boolean).map((line) => {
            const [hash, subject, author, when] = line.split("\x1f");
            return { hash: hash ?? "", subject: subject ?? "", author: author ?? "", when: when ?? "" };
          });
        }
        return { projectId: projectIdForPath(path), name: basename(path), branch, ahead: Number.isFinite(ahead) ? ahead : 0, commits };
      }))).filter((p): p is NonNullable<typeof p> => !!p);
      return json({ projects });
    }

    // POST /api/boards/:projectId/publish — push the project's current branch to
    // its remote. On repos with deploy CI ([cliente]'s deploy.yml runs on push to
    // main) this IS the deploy trigger — a deliberate, human-initiated action
    // (the board UI gates it behind a confirm).
    const bPublish = matchRoute(pathname, "/api/boards/:projectId/publish");
    if (bPublish && method === "POST") {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
      const path = dirs.find((d) => projectIdForPath(d) === bPublish.projectId);
      if (!path) return json({ error: "progetto non trovato", code: "not_found" }, 404);
      const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
      if (!branch) return json({ error: "HEAD staccato — niente da pubblicare", code: "invalid_input" }, 400);
      const push = await runGitCap(path, ["push", "origin", branch]);
      if (push.code !== 0) {
        return json({ ok: false, branch, error: (push.err || push.out).trim().slice(-400) || "git push fallito" }, 502);
      }
      return json({ ok: true, branch, output: (push.err + "\n" + push.out).trim().slice(-400) });
    }

    // GET /api/boards/:projectId/publish-diff — the unified diff of the commits a
    // publish would push (the SAME range as publish-status' `ahead`). Lets the UI
    // show WHAT ships, line by line, before pushing.
    const bPubDiff = matchRoute(pathname, "/api/boards/:projectId/publish-diff");
    if (bPubDiff && method === "GET") {
      let dirs: string[] = [];
      try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
      const path = dirs.find((d) => projectIdForPath(d) === bPubDiff.projectId);
      if (!path) return json({ error: "progetto non trovato", code: "not_found" }, 404);
      const branch = (await runGitCap(path, ["symbolic-ref", "--short", "HEAD"])).out.trim();
      if (!branch) return json({ error: "HEAD staccato", code: "invalid_input" }, 400);
      const upstream = (await runGitCap(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).out.trim();
      const range = upstream && !upstream.includes("fatal") ? `${upstream}..HEAD` : `origin/${branch}..HEAD`;
      const bundle = await gitDiffBundle(path, range);
      return json({ branch, range, ...bundle });
    }

    // GET /api/boards/:projectId/tasks/:taskId/diff — the unified diff of what a
    // dispatched task changed in its own isolated worktree (vs the branch point).
    // Resolves task → topic → worktree (same chain as auto-merge); returns an
    // empty bundle with a code when the task has no isolated worktree yet.
    const bTaskDiff = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/diff");
    if (bTaskDiff && method === "GET") {
      const empty = { stat: [], patch: "", truncated: false };
      let topicId: string | null | undefined;
      try { topicId = svc.get(bTaskDiff.taskId, { projectId: bTaskDiff.projectId })?.task.assignedTopicId; }
      catch { topicId = null; }
      if (!topicId) return json({ code: "no_worktree", branch: null, ...empty });
      const worktreeId = ctx.getTopicById(topicId)?.worktreeId;
      const wt = worktreeId ? ctx.worktreeStore.get(worktreeId) : null;
      if (!wt || wt.mode !== "branch" || !wt.absPath || !existsSync(wt.absPath)) {
        return json({ code: "no_worktree", branch: wt?.branchName ?? null, ...empty });
      }
      // Diff against the branch point (merge-base) so the bundle is exactly what
      // this task did — committed work on its branch AND any uncommitted edits —
      // without noise from commits main gained meanwhile.
      const base = (await runGitCap(wt.absPath, ["merge-base", "main", "HEAD"])).out.trim() || "main";
      const bundle = await gitDiffBundle(wt.absPath, base);
      return json({ branch: wt.branchName, base, ...bundle });
    }

    // /api/all-boards/settings — the GLOBAL auto-dispatch switch (one for every
    // board, reserved board_settings row '*'). The header pill on any board —
    // including the global one — reads and flips this. `board:dispatch` (no
    // projectId) tells every open board header to update.
    if (pathname === "/api/all-boards/settings") {
      if (method === "GET") {
        try {
          return json({ autoDispatch: svc.getGlobalAutoDispatch(), maxAgentsAuto: svc.getGlobalCap().auto });
        } catch (e) { return fail(e); }
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        const hasAuto = typeof body?.autoDispatch === "boolean";
        const hasCap = typeof body?.maxAgentsAuto === "boolean";
        if (!hasAuto && !hasCap) {
          return json({ error: "autoDispatch and/or maxAgentsAuto (boolean) required", code: "invalid_input" }, 400);
        }
        try {
          let autoDispatch = svc.getGlobalAutoDispatch();
          if (hasAuto) {
            autoDispatch = svc.setGlobalAutoDispatch(body.autoDispatch);
            broadcastToAll({ type: "board:dispatch", autoDispatch });
          }
          // The global cap toggle lives on the reserved '*' row's max_agents_auto;
          // the dispatcher reads it via getGlobalCap() and enforces it machine-wide.
          if (hasCap) svc.setGlobalCap(body.maxAgentsAuto);
          const maxAgentsAuto = svc.getGlobalCap().auto;
          broadcastToAll({ type: "board:global-cap", maxAgentsAuto });
          return json({ autoDispatch, maxAgentsAuto });
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // /api/all-boards/projects — the board index (task-detail project selector).
    //   GET  → every project dir the server knows, as {projectId, name, path}
    //          (projectId = the same hash the boards key on).
    //   POST → scaffold a NEW workspace project (same contract as the session
    //          create-project route: sanitized name, dir + CLAUDE.md, 409 on
    //          collision) so "Nuovo progetto…" works from the board too.
    if (pathname === "/api/all-boards/projects") {
      if (method === "GET") {
        const seen = new Set<string>();
        const projects: Array<{ projectId: string; name: string; path: string }> = [];
        let dirs: string[] = [];
        try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
        for (const raw of dirs) {
          if (typeof raw !== "string" || !raw.startsWith("/")) continue;
          const path = raw.replace(/\/+$/, "");
          if (!path || seen.has(path)) continue;
          seen.add(path);
          projects.push({ projectId: projectIdForPath(path), name: basename(path), path });
        }
        projects.sort((a, b) => a.name.localeCompare(b.name));
        return json({ projects });
      }
      if (method === "POST") {
        if (!opts?.workspaceDir) return json({ error: "workspace not configured", code: "invalid_input" }, 500);
        const body = (await readJSON(req)) as any;
        const safeName = (typeof body?.name === "string" ? body.name.trim() : "").replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeName) return json({ error: "name (alphanumeric) is required", code: "invalid_input" }, 400);
        const dir = join(opts.workspaceDir, safeName);
        if (existsSync(dir)) {
          return json({ error: `project "${safeName}" already exists`, code: "project_exists" }, 409);
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "CLAUDE.md"), `# ${safeName}\n`);
        } catch (e) { return fail(e); }
        return json({ projectId: projectIdForPath(dir), name: safeName, path: dir }, 201);
      }
      return null;
    }

    // ── Human board API (project-scoped, actor="human") ─────────────────────
    // The board UI knows its projectId and drives these directly. A human MAY
    // move a task to 'done' (the review gate only blocks agents), archive it,
    // and approve/reject a pending review.
    if (isBoard) {
      const HUMAN = "user";

      // GET/PATCH /api/boards/:projectId/settings — per-board dispatch config
      // (concurrency cap, effort, worktree, timeout). `autoDispatch` in the
      // patch routes to the GLOBAL switch (see /api/all-boards/settings).
      const bSettings = matchRoute(pathname, "/api/boards/:projectId/settings");
      if (bSettings) {
        const projectId = bSettings.projectId;
        if (method === "GET") {
          try { return json(svc.getBoardSettings(projectId)); } catch (e) { return fail(e); }
        }
        if (method === "PATCH") {
          const body = (await readJSON(req)) as any;
          try {
            const settings = svc.updateBoardSettings(projectId, {
              autoDispatch: typeof body?.autoDispatch === "boolean" ? body.autoDispatch : undefined,
              maxAgents: typeof body?.maxAgents === "number" ? body.maxAgents : undefined,
              dispatchEffort: typeof body?.dispatchEffort === "string" ? body.dispatchEffort : undefined,
              dispatchUseWorktree: typeof body?.dispatchUseWorktree === "boolean" ? body.dispatchUseWorktree : undefined,
              dispatchAutoMerge: typeof body?.dispatchAutoMerge === "boolean" ? body.dispatchAutoMerge : undefined,
              dispatchTimeoutMin: typeof body?.dispatchTimeoutMin === "number" ? body.dispatchTimeoutMin : undefined,
              dispatchMcp: typeof body?.dispatchMcp === "string" ? body.dispatchMcp : undefined,
              dispatchModel: typeof body?.dispatchModel === "string" ? body.dispatchModel : undefined,
            });
            broadcastToAll({ type: "board:settings", projectId, settings });
            // autoDispatch is global — every board header (not just this
            // project's) must flip its pill.
            if (typeof body?.autoDispatch === "boolean") {
              broadcastToAll({ type: "board:dispatch", autoDispatch: settings.autoDispatch });
            }
            return json(settings);
          } catch (e) { return fail(e); }
        }
        return null;
      }

      const bCol = matchRoute(pathname, "/api/boards/:projectId/tasks");
      if (bCol) {
        const projectId = bCol.projectId;
        if (method === "GET") {
          const status = new URL(req.url).searchParams.get("status") || undefined;
          // Root tasks only: a step never renders as its own card (drawer tree).
          try { return json({ tasks: svc.list({ scope: "project", projectId, status: status as any, rootsOnly: true }) }); }
          catch (e) { return fail(e); }
        }
        if (method === "POST") {
          const body = (await readJSON(req)) as any;
          try {
            // Project "Auto": resolve the real board from a known project name
            // mentioned in the task text. Exactly one distinct hit → that board
            // (auto-assigned). None/ambiguous → the catch-all workspace so the
            // task STILL RUNS standalone — a project-less task MUST dispatch (by
            // request). The dispatcher only ticks real boards, so the catch-all
            // is a real (scaffolded, non-git, in-place) board; its "generale"
            // label is hidden client-side (the card treats it as "no project").
            // Only a host with no workspace at all degrades to UNASSIGNED.
            let effectiveProjectId = projectId;
            if (projectId === AUTO_PROJECT_ID) {
              const haystack = `${body?.text ?? ""}\n${body?.description ?? ""}`.toLowerCase();
              const hits = new Set<string>();
              let dirs: string[] = [];
              try { dirs = opts?.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
              for (const raw of dirs) {
                if (typeof raw !== "string" || !raw.startsWith("/")) continue;
                const path = raw.replace(/\/+$/, "");
                const name = basename(path).toLowerCase();
                if (name.length < 3) continue; // too generic to be a mention
                const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(haystack)) hits.add(projectIdForPath(path));
              }
              if (hits.size === 1) {
                effectiveProjectId = [...hits][0];
              } else if (opts?.workspaceDir) {
                const dir = join(opts.workspaceDir, "generale");
                if (!existsSync(dir)) {
                  try {
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(join(dir, "CLAUDE.md"), "# generale\n\nWorkspace catch-all: i task senza progetto girano qui, in-place (non-git).\n");
                    // Non-git → dispatch in-place (no worktree). Nothing else to
                    // set: a fresh board defaults autoDispatch on, so a project-
                    // less task starts without any manual setup.
                    svc.updateBoardSettings(projectIdForPath(dir), { dispatchUseWorktree: false });
                  } catch { /* fall through to unassigned below */ }
                }
                effectiveProjectId = existsSync(dir) ? projectIdForPath(dir) : UNASSIGNED_PROJECT_ID;
              } else {
                effectiveProjectId = UNASSIGNED_PROJECT_ID; // degraded host (no workspace)
              }
            }
            const task = svc.create({
              projectId: effectiveProjectId,
              text: body?.text,
              description: body?.description ?? null,
              priority: typeof body?.priority === "number" ? body.priority : undefined,
              assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
              status: typeof body?.status === "string" ? body.status : undefined,
              parentTaskId: typeof body?.parentTaskId === "string" ? body.parentTaskId : null,
              planFirst: body?.planFirst === true,
              model: typeof body?.model === "string" ? body.model : null,
              blockedByTaskId: typeof body?.blockedByTaskId === "string" ? body.blockedByTaskId : null,
              reuseBlockerContext: body?.reuseBlockerContext === true,
            });
            broadcastToAll({ type: "task:created", projectId: effectiveProjectId, task });
            // A task born directly in Todo is the same "vai" signal as a drag
            // into Todo: same chip, same grace window — not a silent 10s wait
            // for the reconcile poll. No-op when auto-dispatch is off.
            if (dispatcher && task.status === "todo") dispatcher.onEnterTodo(effectiveProjectId, task.id);
            // Adding a STEP under an agent-bound root in review IS the
            // assignment — no "please also do X" comment ceremony: re-kick the
            // same agent with the new step. (Root mid-turn: the step just lands
            // in the tree; the open_subtasks gate keeps approve honest and the
            // resume prompt tells the agent to re-read its task.)
            try {
              if (dispatcher && task.parentTaskId) {
                const root = svc.boundRootOf(task.id);
                if (root && root.status === "review" && root.assignedTopicId) {
                  const rejected = svc.reviewDecision({ taskId: root.id, by: "user", decision: "reject", projectId });
                  broadcastToAll({ type: "task:updated", projectId, task: rejected });
                  void dispatcher.resume(root.id, `L'umano ha aggiunto un nuovo step al tuo task: "${task.text.slice(0, 80)}" (id=${task.id}). Lavoralo e marcalo done prima della consegna.`);
                }
              }
            } catch { /* best-effort — the step itself is already created */ }
            return json(task, 201);
          } catch (e) { return fail(e); }
        }
        return null;
      }

      // POST /api/boards/:projectId/tasks/:taskId/stop — the human pulls the
      // plug on a running dispatch ("ho sbagliato qualcosa"). Order matters:
      // park FIRST (backlog + reason), THEN cut the turn — so when the aborted
      // turn's onTurnEnd fires it finds the task already moved and just drops
      // the chip instead of auto-requeueing a fresh attempt.
      const bStop = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/stop");
      if (bStop && method === "POST") {
        try {
          const got = svc.get(bStop.taskId, { projectId: bStop.projectId });
          if (!got) return json({ error: "task not found", code: "not_found" }, 404);
          const t = got.task;
          const live = t.assignedTopicId || ["queued", "starting", "working"].includes(t.dispatchState ?? "");
          if (!live) return json({ error: "no active agent on this task", code: "invalid_transition" }, 409);
          const sessionKey = t.assignedTopicId ? "topic:" + t.assignedTopicId.slice(0, 8) : null;
          dispatcher?.onLeaveTodo(t.id); // clears a pending grace timer (queued)
          const parked = svc.release({
            taskId: t.id, requeue: false, by: "user",
            reason: "Fermato da te: agent interrotto. Rimetti il task in Todo per ripartire.",
          });
          broadcastToAll({ type: "task:updated", projectId: bStop.projectId, task: parked });
          if (sessionKey && opts?.abortTurn) void opts.abortTurn(sessionKey).catch(() => { /* best-effort */ });
          return json(parked);
        } catch (e) { return fail(e); }
      }

      // POST /api/boards/:projectId/tasks/:taskId/move — send the task (and its
      // subtree) to another board. Both boards get a broadcast so the source
      // drops the card and the target picks it up live.
      const bMove = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/move");
      if (bMove && method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const task = svc.moveToProject({
            taskId: bMove.taskId,
            projectId: bMove.projectId,
            toProjectId: typeof body?.toProjectId === "string" ? body.toProjectId : "",
          });
          broadcastToAll({ type: "task:updated", projectId: bMove.projectId, task });
          if (task.projectId !== bMove.projectId) {
            broadcastToAll({ type: "task:updated", projectId: task.projectId, task });
            // A project-less (or re-homed) task sitting in todo becomes
            // dispatchable the moment it lands on a real board — same "vai"
            // signal as a drag into todo. No-op for the unassigned sentinel.
            if (dispatcher && task.status === "todo") dispatcher.onEnterTodo(task.projectId, task.id);
          }
          return json(task);
        } catch (e) { return fail(e); }
      }

      const bReview = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/review");
      if (bReview && method === "POST") {
        const body = (await readJSON(req)) as any;
        const decision = body?.decision === "approve" ? "approve" : body?.decision === "reject" ? "reject" : null;
        if (!decision) return json({ error: "decision must be 'approve' or 'reject'", code: "invalid_input" }, 400);
        try {
          const comment = typeof body?.comment === "string" ? body.comment : undefined;
          const task = svc.reviewDecision({
            taskId: bReview.taskId, by: HUMAN, decision, comment,
            projectId: bReview.projectId,
          });
          broadcastToAll({ type: "task:updated", projectId: bReview.projectId, task });
          // Reject re-kicks the SAME agent tab with the human's feedback (a
          // "Serve te" answer routes through here too), so the conversation
          // resumes instead of a fresh agent spawning. reviewDecision already
          // moved it back to in_progress.
          if (dispatcher && decision === "reject" && task.assignedTopicId) {
            void dispatcher.resume(bReview.taskId, comment ?? "");
          }
          // Approve lands the task in done → its dependents are now claimable.
          if (dispatcher && decision === "approve" && task.status === "done") {
            dispatcher.onBlockerDone(bReview.taskId);
            // Opt-in auto-merge (board setting): land the task's branch on main.
            // Fire-and-forget — a slow/failed git op must never delay or break the
            // approve response. All outcomes surface as a system comment.
            const autoMerge = opts?.autoMerge;
            if (autoMerge && svc.getBoardSettings(bReview.projectId).dispatchAutoMerge) {
              const { projectId, taskId } = bReview;
              void (async () => {
                try {
                  const res = await autoMerge.tryMerge(taskId, task.text);
                  if (res.status === "merged") {
                    svc.addComment({ taskId, author: "system", content: `Mergiato su main (commit ${res.commit}).` });
                  } else if (res.status === "conflict") {
                    // Not landed → hand it back to the task's own agent, which knows
                    // what it changed. Move it out of done so the resume has a home.
                    svc.update({ taskId, actor: "human", by: HUMAN, projectId, patch: { status: "in_progress" } });
                    svc.addComment({ taskId, author: "system", content: "Merge automatico in conflitto con main — rimando all'agent per risolvere." });
                    void dispatcher.resume(
                      taskId,
                      'Il merge automatico del tuo branch su main è andato in conflitto. Porta main dentro il tuo branch (git merge main, oppure rebase), risolvi i conflitti, poi rimetti in review con update_task(status="review").',
                    );
                  } else if (res.status === "skipped") {
                    svc.addComment({ taskId, author: "system", content: `Merge automatico saltato: ${res.reason}.` });
                  }
                  // 'nothing' (no commits to merge) → stay quiet.
                  const updated = svc.get(taskId, { projectId })?.task;
                  if (updated) broadcastToAll({ type: "task:updated", projectId, task: updated });
                } catch (e) {
                  console.error("[automerge] post-approve wiring failed for", taskId, e);
                }
              })();
            }
          }
          return json(task);
        } catch (e) { return fail(e); }
      }

      const bComments = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId/comments");
      if (bComments && method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const comment = svc.addComment({
            taskId: bComments.taskId, author: HUMAN, content: body?.content,
            mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
            media: filterMedia(body?.media),
            projectId: bComments.projectId,
          });
          const task = svc.get(bComments.taskId, { projectId: bComments.projectId })?.task;
          broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task });
          // Answering on a STEP is answering the agent: when the subtree's
          // dispatch root sits in review ("serve te"), a human comment anywhere
          // under it re-kicks the same agent tab with the step reference — the
          // specific reply lives on the step's own thread, not necessarily on
          // the main task's. Best-effort: the comment above is already saved.
          try {
            const root = dispatcher ? svc.boundRootOf(bComments.taskId) : null;
            if (dispatcher && root && root.status === "review" && root.assignedTopicId) {
              const rejected = svc.reviewDecision({
                taskId: root.id, by: HUMAN, decision: "reject", projectId: bComments.projectId,
              });
              broadcastToAll({ type: "task:updated", projectId: bComments.projectId, task: rejected });
              const text = typeof body?.content === "string" ? body.content : "";
              let msg = root.id === bComments.taskId
                ? text
                : `Commento sul tuo sottotask "${(task?.text ?? "").slice(0, 60)}" (id=${bComments.taskId}): ${text}`;
              // Attachments ride along as disk paths — the agent reads them
              // directly (screenshots, docs, mockups the human dropped in).
              if (comment.media.length) msg += `\nAllegati (file su disco, leggili): ${comment.media.join(" ")}`;
              void dispatcher.resume(root.id, msg);
            }
          } catch { /* the root may have moved meanwhile */ }
          return json(comment, 201);
        } catch (e) { return fail(e); }
      }

      const bItem = matchRoute(pathname, "/api/boards/:projectId/tasks/:taskId");
      if (bItem) {
        const { projectId, taskId } = bItem;
        if (method === "GET") {
          const got = svc.get(taskId, { projectId });
          if (!got) return json({ error: "task not found", code: "not_found" }, 404);
          return json(got);
        }
        if (method === "PATCH") {
          const body = (await readJSON(req)) as any;
          try {
            const prevStatus = svc.get(taskId, { projectId })?.task.status;
            const task = svc.update({
              taskId, actor: "human", by: HUMAN, projectId,
              patch: {
                status: typeof body?.status === "string" ? body.status : undefined,
                priority: typeof body?.priority === "number" ? body.priority : undefined,
                assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
                text: typeof body?.text === "string" ? body.text : undefined,
                description: body?.description !== undefined ? body.description : undefined,
                kanbanOrder: typeof body?.kanbanOrder === "number" ? body.kanbanOrder : undefined,
                outputUrl: typeof body?.outputUrl === "string" ? body.outputUrl : undefined,
                model: body?.model !== undefined ? (typeof body.model === "string" ? body.model : null) : undefined,
                blockedByTaskId: body?.blockedByTaskId !== undefined
                  ? (typeof body.blockedByTaskId === "string" && body.blockedByTaskId ? body.blockedByTaskId : null)
                  : undefined,
                reuseBlockerContext: typeof body?.reuseBlockerContext === "boolean" ? body.reuseBlockerContext : undefined,
                planFirst: typeof body?.planFirst === "boolean" ? body.planFirst : undefined,
              },
            });
            broadcastToAll({ type: "task:updated", projectId, task });
            // Auto-dispatch trigger: the human dragging a task INTO todo is the
            // "vai" signal; dragging it back OUT while still queued cancels it.
            // The dispatcher itself no-ops when auto_dispatch is off for the board.
            if (dispatcher && prevStatus !== task.status) {
              if (task.status === "todo") dispatcher.onEnterTodo(projectId, taskId);
              else if (prevStatus === "todo") dispatcher.onLeaveTodo(taskId);
              // Reaching done releases whatever was waiting on this task.
              if (task.status === "done") dispatcher.onBlockerDone(taskId);
            }
            return json(task);
          } catch (e) { return fail(e); }
        }
        if (method === "DELETE") {
          try {
            const task = svc.archive({ taskId, projectId });
            broadcastToAll({ type: "task:deleted", projectId, taskId });
            return json({ ok: true, task });
          } catch (e) { return fail(e); }
        }
        return null;
      }
      return null;
    }

    // POST/GET /api/sessions/:sessionKey/tasks
    const collection = matchRoute(pathname, "/api/sessions/:sessionKey/tasks");
    if (collection) {
      const sk = decodeURIComponent(collection.sessionKey);
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);

      if (method === "GET") {
        const params = new URL(req.url).searchParams;
        const scope = params.get("scope") === "all" ? "all" : "project";
        const status = params.get("status") || undefined;
        try {
          const tasks = svc.list({ scope, projectId: sess.projectId, status: status as any });
          return json({ tasks });
        } catch (e) { return fail(e); }
      }
      if (method === "POST") {
        const body = (await readJSON(req)) as any;
        try {
          const task = svc.create({
            projectId: sess.projectId,
            text: body?.text,
            description: body?.description ?? null,
            priority: typeof body?.priority === "number" ? body.priority : undefined,
            assignedTo: typeof body?.assignee === "string" ? body.assignee : null,
            // Agents/MCP always create into `backlog` (intake), never straight into
            // the "todo" run-queue: a task only becomes dispatch-eligible when a
            // HUMAN moves it to todo. Symmetric to the agent-cannot-mark-done gate.
            status: "backlog",
            idempotencyKey: typeof body?.idempotency_key === "string" ? body.idempotency_key : null,
            parentTaskId: typeof body?.parent_task_id === "string" ? body.parent_task_id : null,
          });
          broadcastToAll({ type: "task:created", projectId: sess.projectId, task });
          return json(task, 201);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    // POST /api/sessions/:sessionKey/tasks/:taskId/comments
    const commentsRoute = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId/comments");
    if (commentsRoute && method === "POST") {
      const sk = decodeURIComponent(commentsRoute.sessionKey);
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
      const body = (await readJSON(req)) as any;
      // Agent comments must stay SHORT and useful — the thread is a status
      // trail for the human, not a log sink. The cap only applies to the agent
      // surface (humans on /api/boards are uncapped); the error text coaches
      // the model to summarize and retry.
      if (typeof body?.content === "string" && body.content.length > AGENT_COMMENT_MAX_CHARS) {
        return json({
          error: `comment too long (${body.content.length} chars, max ${AGENT_COMMENT_MAX_CHARS}) — summarize: 1-2 short sentences, no logs or code dumps`,
          code: "comment_too_long",
        }, 400);
      }
      // Attachments outside the allowlist must FAIL LOUDLY for an agent: the
      // silent drop shipped a "PDF allegato qui" comment with no PDF and
      // nobody knew why. Coach the remedy (same pattern as comment_too_long).
      const requestedMedia = Array.isArray(body?.media) ? body.media.filter((m: unknown) => typeof m === "string").length : 0;
      const media = filterMedia(body?.media);
      if (requestedMedia > 0 && (media?.length ?? 0) < requestedMedia) {
        return json({
          error:
            "some attachments are outside the allowed dirs — copy the file(s) into ~/.openclaw/uploads/ (or the workspace) and re-attach from there",
          code: "media_path_not_allowed",
        }, 400);
      }
      try {
        const comment = svc.addComment({
          taskId: commentsRoute.taskId,
          author: sess.author,
          content: body?.content,
          mentions: Array.isArray(body?.mentions) ? body.mentions : undefined,
          // The agent can attach files too (screenshots/artifacts it produced).
          media,
          projectId: sess.projectId,
          // Structured human-decision request: the service composes the
          // canonical ```question``` block from these (KANBAN-07 quick-reply).
          questionOptions: Array.isArray(body?.options)
            ? body.options.filter((o: unknown) => typeof o === "string")
            : undefined,
        });
        const task = svc.get(commentsRoute.taskId, { projectId: sess.projectId })?.task;
        broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
        return json(comment, 201);
      } catch (e) { return fail(e); }
    }

    // GET/PATCH /api/sessions/:sessionKey/tasks/:taskId
    const item = matchRoute(pathname, "/api/sessions/:sessionKey/tasks/:taskId");
    if (item) {
      const sk = decodeURIComponent(item.sessionKey);
      const sess = resolveSession(sk);
      if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);

      if (method === "GET") {
        const got = svc.get(item.taskId, { projectId: sess.projectId });
        if (!got) return json({ error: "task not found", code: "not_found" }, 404);
        return json(got);
      }
      if (method === "PATCH") {
        const body = (await readJSON(req)) as any;
        try {
          const task = svc.update({
            taskId: item.taskId,
            actor: "agent",
            by: sess.author,
            projectId: sess.projectId,
            agentTopicId: sess.topicId,
            patch: {
              status: typeof body?.status === "string" ? body.status : undefined,
              priority: typeof body?.priority === "number" ? body.priority : undefined,
              assignedTo: typeof body?.assignee === "string" ? body.assignee : undefined,
              outputUrl: typeof body?.output_url === "string" ? body.output_url : undefined,
              // The agent may refine wording (a raw composer-born title →
              // clear, concise one). Same projectId guard as everything else.
              text: typeof body?.text === "string" && body.text.trim() ? body.text : undefined,
              description: typeof body?.description === "string" ? body.description : undefined,
            },
          });
          broadcastToAll({ type: "task:updated", projectId: sess.projectId, task });
          return json(task);
        } catch (e) { return fail(e); }
      }
      return null;
    }

    return null;
  };
}
