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
import type { RestoreBlockerCode, RestorePlan, RestoreVerdict } from "../../shared/checkpoint-plan";
import {
  captureTurnCheckpoint,
  listRestorePoints,
  type TurnCheckpoint,
} from "../services/turn-checkpoints";
import { applyRestorePlan, buildRestorePlan } from "../services/checkpoint-restore-plan";

/**
 * A plan that can touch nothing, for a checkpoint with no tree to go back to:
 * one saved before file snapshots existed, or one whose topic has no
 * repository. The service never emits `legacy-checkpoint`; only this route
 * knows that a manual checkpoint may predate the feature.
 */
function refusedPlan(code: RestoreBlockerCode, targetCommit = ""): RestorePlan {
  return { targetCommit, latestCommit: null, entries: [], skipped: [], blockers: [{ code }], safe: false };
}

/**
 * The blockers that stop the WHOLE gesture. The other codes (`not-a-repo`,
 * `legacy-checkpoint`) only say the files half cannot happen: a manual
 * checkpoint still rolls its conversation back, which is what every checkpoint
 * did before file snapshots existed and what a topic without a folder does
 * today. Taking that gesture away would break both for a reason the user
 * never asked about.
 */
const STOPS_THE_GESTURE: ReadonlySet<RestoreBlockerCode> = new Set([
  "turn-in-progress",
  "other-session-active",
  "no-checkpoint",
]);

/**
 * What the route lets the gesture do, next to the plan. A manual rollback has
 * a conversation half that survives a files-only blocker; a turn restore
 * (`/rewind`) has no other half, so ANY blocker stops it.
 */
function verdictFor(plan: RestorePlan, gesture: "manual" | "turn"): RestoreVerdict {
  const stop = plan.blockers.find((b) => STOPS_THE_GESTURE.has(b.code));
  const blockedBy = stop?.code ?? plan.blockers[0]?.code;
  return {
    canProceed: gesture === "turn" ? plan.safe : stop === undefined,
    ...(blockedBy ? { blockedBy } : {}),
    filesRestorable: plan.safe,
  };
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

async function saveCheckpoints(baseDir: string, topicId: string, checkpoints: Checkpoint[]): Promise<void> {
  const path = join(getCheckpointsDir(baseDir), `${topicId}.json`);
  await Bun.write(path, JSON.stringify(checkpoints, null, 2));
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
          // THE TREE, not just HEAD. `gitHash` is where the branch was, which
          // may be hours older than the worktree the user is looking at; a
          // rollback from it rewrote every path to a commit nobody asked for.
          // The snapshot records the worktree as it stands, on the same ref
          // namespace as the automatic checkpoints, so a rollback is a plan
          // over the paths this session changed since, and nothing else.
          //
          // `captureTurnCheckpoint` answers null when the newest restore point
          // already holds these bytes: that point IS the tree, so it is the
          // one recorded. Never fatal: a checkpoint without a tree still rolls
          // the conversation back, as every checkpoint did before this.
          try {
            const snap = await captureTurnCheckpoint(topic.projectPath, topic.sessionKey, checkpoint.description, "manual");
            const commit = snap?.commit ?? (await listRestorePoints(topic.projectPath, topic.sessionKey))[0]?.commit;
            if (commit) checkpoint.treeCommit = commit;
          } catch (err) {
            console.warn(`[Checkpoints] tree snapshot failed for ${topic.sessionKey}:`, err);
          }
        }

        checkpoints.push(checkpoint);
        await saveCheckpoints(STATE_DIR, params.id, checkpoints);

        return json({ checkpoint });
      }
    }

    // The plan of a MANUAL checkpoint: what its rollback would do to the
    // files. Shared by the preflight and the rollback so the two never
    // disagree on the same checkpoint.
    const planForManual = async (topic: { projectPath?: string; sessionKey: string }, checkpoint: Checkpoint): Promise<RestorePlan> => {
      if (!topic.projectPath || !existsSync(topic.projectPath)) return refusedPlan("not-a-repo");
      if (!checkpoint.treeCommit) return refusedPlan("legacy-checkpoint");
      return buildRestorePlan(topic.projectPath, topic.sessionKey, checkpoint.treeCommit, {
        turnActive: ctx.activeStreams.has(topic.sessionKey),
      });
    };

    // POST /api/topics/:id/checkpoints/:idx/plan: the preflight the UI reads
    // to decide whether its button is enabled and what its dialog promises.
    // Always 200, refused plans included: a blocked plan is an answer, not
    // an error.
    {
      const params = matchRoute(pathname, "/api/topics/:id/checkpoints/:idx/plan");
      if (params && method === "POST") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);
        const checkpoint = loadCheckpoints(STATE_DIR, params.id)[parseInt(params.idx)];
        if (!checkpoint) return json({ error: "Checkpoint not found" }, 404);
        const plan = await planForManual(topic, checkpoint);
        return json({ checkpoint, plan, ...verdictFor(plan, "manual") });
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

        // THE FILES, first and by plan. Here there used to be an auto-stash of
        // every uncommitted change in the repository followed by
        // `git restore --source <gitHash> -- .`: it stashed the work of whoever
        // else was in the folder, then rewrote EVERY path from a commit that
        // could be hours older than the checkpoint. The plan touches only the
        // paths this session changed since the checkpoint's own tree, skips
        // the ones somebody else edited after, and refuses outright while a
        // turn is writing. Files before conversation: a git failure here
        // leaves the conversation intact and answers 500, not half a rollback.
        const plan = await planForManual(topic, checkpoint);
        const verdict = verdictFor(plan, "manual");
        if (!verdict.canProceed) return json({ error: "Restore refused", plan, ...verdict }, 409);
        let files: Awaited<ReturnType<typeof applyRestorePlan>> | null = null;
        if (verdict.filesRestorable && topic.projectPath) {
          try {
            files = await applyRestorePlan(topic.projectPath, plan);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : "Restore failed", plan, ...verdict }, 500);
          }
        }

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
        await saveCheckpoints(STATE_DIR, params.id, remaining);

        return json({ ok: true, messageCount: keep, removed: truncation.deletedMessages, plan, ...verdict, files });
      }
    }

    // GET /api/topics/:id/turn-checkpoints — the AUTOMATIC ones (per turn).
    //
    // A different list from the manual checkpoints above, and deliberately so:
    // these live in git refs, not in a JSON file, they carry no message count,
    // and restoring one does NOT touch the conversation. Merging the two lists
    // would mean one strip where half the entries silently rewind the chat and
    // half do not.
    {
      const params = matchRoute(pathname, "/api/topics/:id/turn-checkpoints");
      if (params && method === "GET") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);
        if (!topic.projectPath || !existsSync(topic.projectPath)) return json({ checkpoints: [] });
        // Restore points only: the end-of-turn `after` marks are bookkeeping
        // for the plan, never a moment anybody asked to go back to.
        return json({ checkpoints: await listRestorePoints(topic.projectPath, topic.sessionKey) });
      }
    }

    // Which automatic restore point a body names: `{ commit? }`, and without
    // one the NEWEST, which is the tree as it was before the last turn: "undo
    // what just happened" is the gesture, and it should not need a hash.
    // Shared by the preflight and the restore, so they never pick differently.
    const targetTurnPoint = async (
      topic: { projectPath?: string; sessionKey: string }, req: Request,
    ): Promise<{ checkpoint: TurnCheckpoint | null; plan: RestorePlan }> => {
      if (!topic.projectPath || !existsSync(topic.projectPath)) return { checkpoint: null, plan: refusedPlan("not-a-repo") };
      let body: { commit?: string } = {};
      try { body = await req.json(); } catch {}
      const list = await listRestorePoints(topic.projectPath, topic.sessionKey);
      const target = body.commit ? list.find((c) => c.commit === body.commit) : list[0];
      if (!target) return { checkpoint: null, plan: refusedPlan("no-checkpoint", body.commit ?? "") };
      const plan = await buildRestorePlan(topic.projectPath, topic.sessionKey, target.commit, {
        turnActive: ctx.activeStreams.has(topic.sessionKey),
      });
      return { checkpoint: target, plan };
    };

    // POST /api/topics/:id/turn-checkpoints/plan: the preflight. Always 200,
    // refused plans included, same reason as the manual one above.
    {
      const params = matchRoute(pathname, "/api/topics/:id/turn-checkpoints/plan");
      if (params && method === "POST") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);
        const { checkpoint, plan } = await targetTurnPoint(topic, req);
        return json({ checkpoint, plan, ...verdictFor(plan, "turn") });
      }
    }

    // POST /api/topics/:id/turn-checkpoints/restore: this is what `/rewind` calls.
    // A refused plan is a 409 carrying the plan, so the client can name the
    // blocker in its own words; a safe one is applied and answered with the
    // outcome AND the plan, so the skipped paths can be named too.
    {
      const params = matchRoute(pathname, "/api/topics/:id/turn-checkpoints/restore");
      if (params && method === "POST") {
        const data = loadTopics();
        const topic = data.topics[params.id];
        if (!topic) return json({ error: "Topic not found" }, 404);
        if (!topic.projectPath || !existsSync(topic.projectPath)) {
          return json({ error: "This chat is not bound to a project folder" }, 400);
        }
        const { checkpoint, plan } = await targetTurnPoint(topic, req);
        const verdict = verdictFor(plan, "turn");
        if (!checkpoint || !verdict.canProceed) return json({ error: "Restore refused", plan, ...verdict }, 409);
        try {
          const outcome = await applyRestorePlan(topic.projectPath, plan);
          return json({ ok: true, checkpoint, plan, ...verdict, ...outcome });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : "Restore failed", plan, ...verdict }, 500);
        }
      }
    }

    return null;
  };
}
