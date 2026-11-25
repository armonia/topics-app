/**
 * Wires the cross-machine worktree routes (change worktree-standard, track T12)
 * to this host: one summary source shared by the node half (what this server
 * answers its primary) and the primary half (what it shows and sends about its
 * nodes, its own line included). The decisions live in `routes/nodes-worktrees.ts`,
 * `routes/machine-worktrees.ts` and `services/worktree-summary.ts`; this file only
 * connects them.
 */
import { hostname } from "node:os";
import type { AppContext } from "../types";
import type { NodeClient } from "../services/node-client";
import { readNodeToken } from "../services/node-client";
import type { WorktreeGcRunner } from "../services/worktree-gc-runner";
import { createWorktreeSummarySource } from "../services/worktree-summary";
import { toPlanPayload } from "../services/worktree-plan-payload";
import { freeDiskGB } from "../services/dispatch-capacity";
import { getAppSettings, updateAppSettings } from "../services/app-settings";
import { validateSettingsPatch } from "../routes/app-settings";
import { isCloudBaseUrl } from "../providers/claude-cloud/node";
import type { NodeWorktreesDeps } from "../routes/nodes-worktrees";
import type { MachineWorktreesDeps } from "../routes/machine-worktrees";

export function createWorktreeReportDeps(ctx: AppContext, opts: {
  worktreeGc: Pick<WorktreeGcRunner, "planWorktreeGc" | "runWorktreeGc">;
  nodeClient: Pick<NodeClient, "putWorktreePolicy" | "worktreeGc">;
}): { node: () => NodeWorktreesDeps; machine: () => MachineWorktreesDeps } {
  const projectName = (id: string) => ctx.projectStore.get(id)?.name ?? null;
  const plan = async (weigh: boolean) => {
    const p = await opts.worktreeGc.planWorktreeGc({ weigh });
    return p ? toPlanPayload(p, projectName) : null;
  };
  const summary = createWorktreeSummarySource({
    plan: ({ weigh }) => plan(weigh),
    root: () => ctx.worktreeManager.worktreesDir(),
    freeGb: freeDiskGB,
    log: (message, err) => console.warn(`[worktree-summary] ${message}`, err),
  });

  const node = (): NodeWorktreesDeps => ({
    summary,
    plan: () => plan(false),
    runGc: () => opts.worktreeGc.runWorktreeGc(),
    settings: () => getAppSettings(),
    validate: (body) => validateSettingsPatch(body, ctx.projectStore.list()),
    apply: (patch) => { updateAppSettings(patch); },
  });

  const machine = (): MachineWorktreesDeps => ({
    local: () => ({ machine: ctx.machineStore.getByHostname(hostname()), summary: summary.current() }),
    nodes: () => ctx.machineStore.list().filter((m) => !!m.baseUrl && !isCloudBaseUrl(m.baseUrl)),
    report: (id) => ctx.machineStore.worktreeReport(id),
    tokenOf: (id) => readNodeToken(ctx.STATE_DIR, id),
    client: opts.nodeClient,
  });

  return { node, machine };
}
