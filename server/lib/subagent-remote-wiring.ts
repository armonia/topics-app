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
import type { MacOnlyResource } from "./subagent-remote-decision";
import { classifyStayLocal } from "../services/stay-local-sweep";

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
  /** `body.runtime` as the caller sent it: anything but "topics"/absent stays on the local path, which owns the 400. */
  runtime?: unknown;
  runtimeReason: "asked" | "default";
  parentSessionKey: string;
}

/** Failed settles in a row (bundle not arriving, adopt refused, node unpaired) before the parent hears "failed": ~1 min at the 5 s watch. */
export const SETTLE_TRIES = 12;
/** How long a node may stay silent before its child is reported lost. */
export const UNREACHABLE_GIVE_UP_MS = 30 * 60_000;

const BROWSER_WORK = /\bbrowser\b|\bplaywright\b|\bchrome\b|\bsafari\b|\bscreenshot\b|\bbrowser_\w+/i;
const JARVIS_WORK = /\bjarvis\b|\bimessage\b|\bwhatsapp\b|\bgmail\b|\bcalendar\b/i;
const SESSION_WORK = /\bsession_(list|read|send)\b|\btopics-term\b|\btmux\b/i;

/**
 * What only this Mac can hand the child, read off the spawn prompt and profile the same way a card's
 * pin is (`classifyStayLocal`, `stay-local-sweep.ts`), plus the three a child reaches far more often
 * than a card: a browser pane, Jarvis's channels, a live terminal session. Words, not certainty: a
 * prompt that merely mentions one stays here, which costs a local child, never a broken remote one.
 */
export function macOnlyResourceOf(prompt: string, agentType: string | null): MacOnlyResource | null {
  const text = `${prompt}\n${agentType ?? ""}`;
  if (BROWSER_WORK.test(text)) return "browser";
  if (JARVIS_WORK.test(text)) return "jarvis";
  if (SESSION_WORK.test(text)) return "session";
  if (classifyStayLocal({ text }) === "KEEP") return "macos";
  return null;
}

export type SpawnRemoteChildAttemptResult =
  | { ok: true; agentId: string; name: string; cwd: string; branch: string }
  | { ok: false; reason: string };

export function createRemoteSubagentWiring(ctx: AppContext, road: () => RemoteRoad, unreachableGiveUpMs = UNREACHABLE_GIVE_UP_MS) {
  const settling = new Set<string>();
  // Failed settles in a row per child, in memory: a restart gives each child its tries again,
  // which only costs a few more polls of a run that is already done.
  const misses = new Map<string, number>();
  // First failed read of the run per child; also in memory, so a restart restarts the clock.
  const unreachableSince = new Map<string, number>();

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
    // An unknown runtime is the local path's 400 (`childRuntimeFor`), never a remote start.
    if (input.runtime !== undefined && input.runtime !== null && input.runtime !== "topics") return null;
    const id = randomUUID();
    const originCheck = await runGit(["remote", "get-url", "origin"], input.cwd);
    const remote = await spawnRemoteChild({
      id, cwd: input.cwd, prompt: input.prompt, name: input.name, model: input.model, effort: input.effort,
      runtime: input.runtime === "topics" ? "topics" : undefined, isGitRepo: await isGitRepo(input.cwd),
      macOnlyResource: macOnlyResourceOf(input.prompt, input.agentType),
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
      // The node was unpaired or lost its token: nothing will ever answer for this run, and a
      // row left `running` holds a seat of the per-parent cap for good.
      if (!baseUrl || !token) {
        if (bumpMiss(row.id)) finish(row, { failed: true, text: "", detail: "the node is no longer paired: its run cannot be read" });
        return;
      }
      const runId = row.remoteRunId;
      let report: NodeRunReport;
      if (prefetched) {
        report = prefetched;
      } else {
        try {
          report = await r.readRun({ baseUrl, token, runId });
        } catch (err) {
          // The node did not answer. A sleeping PC or a reboot is normal, so this waits much longer
          // than a failed fetch, but not forever: a node gone for good would hold a cap seat.
          const since = unreachableSince.get(row.id) ?? Date.now();
          unreachableSince.set(row.id, since);
          if (Date.now() - since >= unreachableGiveUpMs) {
            finish(row, { failed: true, text: "", detail: `the node has not answered for ${Math.round(unreachableGiveUpMs / 60_000)} min: ${err instanceof Error ? err.message : String(err)} (run ${runId} may still be there)` });
          }
          return;
        }
      }
      unreachableSince.delete(row.id);
      // "blocked": the node parked the run itself (`task-dispatcher.ts`'s
      // CHIP_BLOCKED) — it will never come back no matter how many more
      // times this polls it.
      const failed = report.status === "backlog" && (report.dispatchState === "failed" || report.dispatchState === "blocked");
      if (report.status !== "review" && !failed) return; // still running
      if (getSubagent(getDatabase(), row.id)?.state !== "running") return; // already settled by another tick
      const lastText = report.comments.length ? report.comments[report.comments.length - 1]!.content : "";
      if (failed) {
        finish(row, { failed: true, text: lastText, detail: report.dispatchError || report.reason || "the node parked the run" });
        return;
      }
      if (row.branch) {
        const settled = await settleRemoteChildBranch({
          repoPath: row.cwd, branch: row.branch,
          fetchBundle: () => r.fetchBundle({ baseUrl, token, runId }),
        });
        if (!settled.ok) {
          // A network hiccup must not lose the child's work: the row stays `running` and the next
          // tick fetches again. Only after SETTLE_TRIES does the parent hear it failed, with the
          // reason and the node's run still there to recover by hand.
          console.warn(`[spawn] remote child ${row.id}: branch not landed: ${settled.reason}`);
          if (bumpMiss(row.id)) {
            finish(row, { failed: true, text: lastText, detail: `the child's branch did not come back: ${settled.reason} (run ${runId} on the node still has it)` });
          }
          return;
        }
      }
      finish(row, { failed: false, text: lastText });
    } finally {
      settling.delete(row.id);
    }
  }

  /** One more failed settle for this child; true once it has failed SETTLE_TRIES times in a row. */
  function bumpMiss(id: string): boolean {
    const n = (misses.get(id) ?? 0) + 1;
    misses.set(id, n);
    return n >= SETTLE_TRIES;
  }

  /** Retires the row and tells the parent, the same way a local child's turn ends (`emitChildResult`). */
  function finish(row: SubagentRow, outcome: { failed: boolean; text: string; detail?: string }): void {
    misses.delete(row.id);
    unreachableSince.delete(row.id);
    setSubagentState(getDatabase(), row.id, outcome.failed ? "lost" : "retired");
    emitChildResult(row.parentSessionKey, {
      status: outcome.failed ? "failed" : "completed",
      partial: false,
      text: outcome.text,
      ...(outcome.failed ? { reason: { code: "api-error" as const, detail: outcome.detail ?? "the remote run failed" } } : {}),
      agentId: row.id, name: row.name, turn: 1, model: row.model, agentType: row.agentType,
      durationMs: null, cwd: row.cwd,
      // A branch that never landed is not handed to the parent as if it existed.
      branch: outcome.failed ? null : row.branch,
    }, null);
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
