/**
 * SUBAGENT-28: the route wiring of SUBAGENT-25/26/27, kept out of
 * `routes/terminal.ts` (already at its own size ceiling — `check-bloat`).
 * Everything each step does is someone else's pure function; this is the
 * sequencing AND the two places a remote child's life touches the route:
 * its spawn and, once the node is done, its settlement.
 */
import { randomUUID } from "node:crypto";
import { getDatabase } from "../db";
import type { AppContext } from "../types";
import { isCloudBaseUrl } from "../providers/claude-cloud/node";
import { isGitRepo, runGit } from "../services/turn-checkpoints";
import type { BundleResult, CreateRunBody, NodeRunReport } from "../services/node-client";
import { normalizePromptSnippet } from "./claude-subagent-transcript";
import { emitChildResult } from "./subagent-runtime";
import { countRunningRemoteChildren, getSubagent, insertSubagent, markSubagentRemote, runningSubagents, setSubagentState, type SubagentRow } from "./subagent-store";
import { settleRemoteChildBranch } from "./subagent-remote-return";
import { type ChildNodeCandidate } from "./subagent-remote-run";
import { spawnRemoteChild } from "./subagent-remote-spawn";

export interface RemoteRoad {
  baseUrlOf: (machineId: string) => string | null;
  tokenOf: (machineId: string) => string | null;
  readRun: (input: { baseUrl: string; token: string; runId: string }) => Promise<NodeRunReport>;
  createRun: (input: { baseUrl: string; token: string; body: CreateRunBody }) => Promise<{ runId: string }>;
  fetchBundle: (input: { baseUrl: string; token: string; runId: string }) => Promise<BundleResult>;
}

export interface SpawnRemoteChildAttemptInput {
  cwd: string;
  prompt: string;
  name: string;
  model: string | null;
  modelSource: string;
  modelNote?: string;
  effort: string | null;
  agentType: string | null;
  runtime?: "topics" | "claude-code" | null;
  runtimeReason: "asked" | "default";
  parentSessionKey: string;
}

export type SpawnRemoteChildAttemptResult =
  | { ok: true; agentId: string; name: string; cwd: string; branch: string }
  | { ok: false; reason: string };

export function createRemoteSubagentWiring(ctx: AppContext, road: () => RemoteRoad) {
  const settling = new Set<string>();

  /** Paired nodes only, online, with a free seat (SUBAGENT-27): never the cloud machine, which has no door for a bare child run. */
  function childNodeCandidates(): ChildNodeCandidate[] {
    return ctx.machineStore.list()
      .filter((m) => m.status === "online" && !!m.baseUrl && !isCloudBaseUrl(m.baseUrl))
      .map((m) => ({
        machineId: m.id, name: m.name, online: true,
        slots: m.slots ?? 1,
        load: countRunningRemoteChildren(getDatabase(), m.id),
      }));
  }

  /** `null` = never eligible (`spawnRemoteChild` said no): the caller's local spawn runs unchanged. */
  async function trySpawnRemote(input: SpawnRemoteChildAttemptInput): Promise<SpawnRemoteChildAttemptResult | null> {
    if (input.runtime === "claude-code") return null; // decideRemoteSpawn would say the same, skip the git probe
    const id = randomUUID();
    const originCheck = await runGit(["remote", "get-url", "origin"], input.cwd);
    const remote = await spawnRemoteChild({
      id, cwd: input.cwd, prompt: input.prompt, name: input.name, model: input.model, effort: input.effort,
      runtime: input.runtime, isGitRepo: await isGitRepo(input.cwd),
      originUrl: originCheck.code === 0 && originCheck.stdout ? originCheck.stdout : null,
      nodes: childNodeCandidates(),
      baseUrlOf: road().baseUrlOf, tokenOf: road().tokenOf, createRun: road().createRun,
    });
    if (!remote) return null;
    if (!remote.ok) return { ok: false, reason: remote.reason };
    insertSubagent(getDatabase(), {
      id, parentSessionKey: input.parentSessionKey, name: input.name, model: input.model, agentType: input.agentType,
      effort: input.effort, promptSnippet: normalizePromptSnippet(input.prompt), cwd: input.cwd, branch: remote.branch,
      claudeSessionId: null, createdAt: new Date().toISOString(), runtimeReason: input.runtimeReason,
    });
    markSubagentRemote(getDatabase(), id, { machineId: remote.machineId, runId: remote.runId });
    return { ok: true, agentId: id, name: input.name, cwd: input.cwd, branch: remote.branch };
  }

  /**
   * Once the node's run reaches `review`, the branch comes back and adopts
   * into the parent (`subagent-remote-return.ts`), the row retires, and the
   * parent is told the same way a local child's turn ends (`emitChildResult`):
   * `read_agent` AND `wait_agent` both see it, since both read off what this
   * feeds. `prefetched` is the report a caller already paid a network call
   * for (`read_agent`'s own poll of the run); without one this fetches its own.
   */
  async function settleIfDone(row: SubagentRow, prefetched?: NodeRunReport): Promise<void> {
    if (!row.remoteMachineId || !row.remoteRunId || settling.has(row.id)) return;
    settling.add(row.id);
    try {
      const r = road();
      const baseUrl = r.baseUrlOf(row.remoteMachineId);
      const token = r.tokenOf(row.remoteMachineId);
      if (!baseUrl || !token) return;
      const runId = row.remoteRunId;
      let report: NodeRunReport;
      if (prefetched) {
        report = prefetched;
      } else {
        try {
          report = await r.readRun({ baseUrl, token, runId });
        } catch { return; } // the node did not answer: the next tick tries again
      }
      // "blocked": the node parked the run itself (`task-dispatcher.ts`'s
      // CHIP_BLOCKED) — it will never come back no matter how many more
      // times this polls it.
      const failed = report.status === "backlog" && (report.dispatchState === "failed" || report.dispatchState === "blocked");
      if (report.status !== "review" && !failed) return; // still running
      const db = getDatabase();
      if (getSubagent(db, row.id)?.state !== "running") return; // already settled by another tick
      if (!failed && row.branch) {
        const settled = await settleRemoteChildBranch({
          repoPath: row.cwd, branch: row.branch,
          fetchBundle: () => r.fetchBundle({ baseUrl, token, runId }),
        });
        if (!settled.ok) console.warn(`[spawn] remote child ${row.id}: branch not landed: ${settled.reason}`);
      }
      setSubagentState(db, row.id, "retired");
      const lastText = report.comments.length ? report.comments[report.comments.length - 1]!.content : "";
      emitChildResult(row.parentSessionKey, {
        status: failed ? "failed" : "completed",
        partial: false,
        text: lastText,
        ...(failed
          ? { reason: { code: "api-error" as const, detail: report.dispatchError || report.reason || "the node parked the run" } }
          : {}),
        agentId: row.id, name: row.name, turn: 1, model: row.model, agentType: row.agentType,
        durationMs: null, cwd: row.cwd, branch: row.branch,
      }, null);
    } finally {
      settling.delete(row.id);
    }
  }

  /**
   * `wait_agent` holds a foreground spawn until its result arrives
   * (`holdForeground`): a remote child's result only exists once `settleIfDone`
   * runs, so without a tick of its own a caller that never polls `read_agent`
   * would wait for nothing until the hold's own deadline.
   */
  function startWatch(intervalMs = 5_000): () => void {
    const timer = setInterval(() => {
      for (const row of runningSubagents(getDatabase())) {
        if (row.remoteMachineId && row.remoteRunId) settleIfDone(row).catch(() => {});
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { childNodeCandidates, trySpawnRemote, settleIfDone, startWatch };
}
