import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { AppContext, RouteHandler } from "../types";

export interface Checkpoint {
  idx: number;
  messageCount: number;
  timestamp: string;
  description: string;
  gitHash?: string;
  gitBranch?: string;
}

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

function getGitInfo(projectPath: string): { hash: string; branch: string } | null {
  try {
    const hash = execSync("git rev-parse HEAD", { cwd: projectPath, encoding: "utf-8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: projectPath, encoding: "utf-8" }).trim();
    return { hash, branch };
  } catch {
    return null;
  }
}

function hasUncommittedChanges(projectPath: string): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd: projectPath, encoding: "utf-8" }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

export function createCheckpointsRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute, loadTopics, loadLocalMessages, saveLocalMessages, STATE_DIR } = ctx;

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
          const gitInfo = getGitInfo(topic.projectPath);
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

        // Truncate messages to checkpoint count
        const msgs = loadLocalMessages(topic.sessionKey);
        const truncated = msgs.slice(0, checkpoint.messageCount);
        saveLocalMessages(topic.sessionKey, truncated);

        // Remove checkpoints after this one
        const remaining = checkpoints.slice(0, idx + 1);
        saveCheckpoints(STATE_DIR, params.id, remaining);

        // Git rollback if applicable
        let gitResult: { rolled: boolean; warning?: string } = { rolled: false };
        if (checkpoint.gitHash && topic.projectPath && existsSync(topic.projectPath)) {
          try {
            if (hasUncommittedChanges(topic.projectPath)) {
              // Stash current changes first
              execSync("git stash push -m 'Topics checkpoint rollback auto-stash'", {
                cwd: topic.projectPath, encoding: "utf-8",
              });
              gitResult.warning = "Uncommitted changes were stashed";
            }
            execSync(`git checkout ${checkpoint.gitHash}`, {
              cwd: topic.projectPath, encoding: "utf-8",
            });
            gitResult.rolled = true;
          } catch (err: any) {
            gitResult.warning = err.message || "Git rollback failed";
          }
        }

        return json({ ok: true, messageCount: truncated.length, git: gitResult });
      }
    }

    return null;
  };
}
