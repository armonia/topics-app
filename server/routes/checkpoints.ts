import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";
import { truncateSessionAfter } from "../db/message-tree";

/**
 * Run a git command via async subprocess. The prior execSync froze Bun's single
 * event loop for the full duration of every git call — on a large repo `git
 * status`/`checkout` can take hundreds of ms during which NO other request, WS
 * message, or timer runs. Array args also mean the checkpoint hash is passed as
 * a literal argv entry (no shell), closing the interpolation-injection surface.
 * Returns trimmed stdout; throws on non-zero exit so callers keep their try/catch.
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(err.trim() || `git ${args[0]} exited ${code}`);
  return out.trim();
}

// Forma del checkpoint: `shared/types.ts` (la legge il client in useCheckpoints).
import type { Checkpoint } from "../../shared/types";

function getCheckpointsDir(baseDir: string): string {
  const dir = join(baseDir, "checkpoints");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function loadCheckpoints(baseDir: string, topicId: string): Checkpoint[] {
  const path = join(getCheckpointsDir(baseDir), `${topicId}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function saveCheckpoints(baseDir: string, topicId: string, checkpoints: Checkpoint[]) {
  const path = join(getCheckpointsDir(baseDir), `${topicId}.json`);
  Bun.write(path, JSON.stringify(checkpoints, null, 2));
}

async function getGitInfo(projectPath: string): Promise<{ hash: string; branch: string } | null> {
  try {
    const hash = await runGit(["rev-parse", "HEAD"], projectPath);
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
    return { hash, branch };
  } catch {
    return null;
  }
}

async function hasUncommittedChanges(projectPath: string): Promise<boolean> {
  try {
    const status = await runGit(["status", "--porcelain"], projectPath);
    return status.length > 0;
  } catch {
    return false;
  }
}

export function createCheckpointsRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute, loadTopics, loadLocalMessages, STATE_DIR } = ctx;

  return async function checkpointsRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/topics/:id/checkpoints
    {
      const params = matchRoute(pathname, "/api/topics/:id/checkpoints");
      if (params && method === "GET") {
        const checkpoints = loadCheckpoints(STATE_DIR, params.id);
        return json({ checkpoints });
      }
    }

    // POST /api/topics/:id/checkpoints — create a checkpoint
    {
      const params = matchRoute(pathname, "/api/topics/:id/checkpoints");
      if (params && method === "POST") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);

        let body: { description?: string } = {};
        try { body = await req.json(); } catch {}

        const msgs = loadLocalMessages(topic.sessionKey);
        const checkpoints = loadCheckpoints(STATE_DIR, params.id);

        const checkpoint: Checkpoint = {
          idx: checkpoints.length,
          messageCount: msgs.length,
          timestamp: new Date().toISOString(),
          description: body.description || `Checkpoint at ${msgs.length} messages`,
        };

        // Capture git state if topic has a project path
        if (topic.projectPath && existsSync(topic.projectPath)) {
          const gitInfo = await getGitInfo(topic.projectPath);
          if (gitInfo) {
            checkpoint.gitHash = gitInfo.hash;
            checkpoint.gitBranch = gitInfo.branch;
          }
        }

        checkpoints.push(checkpoint);
        saveCheckpoints(STATE_DIR, params.id, checkpoints);

        return json({ checkpoint });
      }
    }

    // POST /api/topics/:id/checkpoints/:idx/rollback
    {
      const params = matchRoute(pathname, "/api/topics/:id/checkpoints/:idx/rollback");
      if (params && method === "POST") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);

        const checkpoints = loadCheckpoints(STATE_DIR, params.id);
        const idx = parseInt(params.idx);
        const checkpoint = checkpoints[idx];
        if (!checkpoint) return json({ error: "Checkpoint not found" }, 404);

        // Taglia la conversazione al checkpoint, SENZA toccare i rami che
        // stanno sopra.
        //
        // Prima qui c'era `saveLocalMessages(sessionKey, msgs.slice(0, n))`, che
        // è un rimpiazzo totale della sessione: cancellava ogni messaggio e
        // reinseriva il solo ramo attivo troncato. Ogni versione alternativa
        // — ogni edit, ogni rigenerazione — spariva insieme, anche se nata
        // prima del punto di ripristino e del tutto estranea al taglio.
        // `truncateSessionAfter` cancella solo il sottoalbero appeso all'ultimo
        // messaggio tenuto (vedi server/db/message-tree.ts).
        const msgs = loadLocalMessages(topic.sessionKey);
        const keep = Math.max(0, Math.min(checkpoint.messageCount, msgs.length));
        const lastKeptId = keep > 0 ? msgs[keep - 1].id : null;
        const truncation = truncateSessionAfter(ctx.db, topic.sessionKey, lastKeptId);

        // Remove checkpoints after this one
        const remaining = checkpoints.slice(0, idx + 1);
        saveCheckpoints(STATE_DIR, params.id, remaining);

        // Git rollback if applicable
        let gitResult: { rolled: boolean; warning?: string } = { rolled: false };
        if (checkpoint.gitHash && topic.projectPath && existsSync(topic.projectPath)) {
          try {
            if (await hasUncommittedChanges(topic.projectPath)) {
              // Stash current changes first
              await runGit(["stash", "push", "-m", "Topics checkpoint rollback auto-stash"], topic.projectPath);
              gitResult.warning = "Uncommitted changes were stashed";
            }
            // `restore --source`, NOT `checkout <hash>`.
            //
            // `git checkout <hash>` moves HEAD onto the commit, which leaves the
            // repository in DETACHED HEAD. That is not a state to drop somebody
            // into when all they asked for was to step back one turn: the next
            // commit they make lands on no branch, and `git status` opens with a
            // paragraph of warning instead of their work. Worse, it is silent
            // here - the response said `rolled: true` and nothing else.
            //
            // `restore --source=<hash> -- .` puts the FILES back and leaves HEAD
            // exactly where it was. Same outcome for the thing the user wanted,
            // without the trap.
            await runGit(["restore", "--source", checkpoint.gitHash, "--", "."], topic.projectPath);
            gitResult.rolled = true;
          } catch (err: any) {
            gitResult.warning = err.message || "Git rollback failed";
          }
        }

        return json({ ok: true, messageCount: keep, removed: truncation.deletedMessages, git: gitResult });
      }
    }

    return null;
  };
}
