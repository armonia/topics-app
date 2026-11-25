/**
 * Routes: the worktrees of every machine, from the PRIMARY's side (change
 * worktree-standard, track T12). The node half is `routes/nodes-worktrees.ts`.
 *
 *   GET  /api/machines/worktrees                    one line per machine (this one measured here,
 *                                                   the nodes from their last heartbeat report)
 *   PUT  /api/machines/:id/worktree-policy          sends a policy to a node (`dryRun` = before/after)
 *   POST /api/machines/:id/worktree-gc[?dryRun=1]   asks a node for a cleanup pass, or its preview
 *
 * This server never touches a node's disk: it sends a policy and asks for a
 * pass, and the node decides each folder with its own safety contract. A node
 * that does not speak the worktree routes (an older build) is skipped, never
 * called: the answer says so and is not an error.
 */
import type { AppContext, RouteHandler } from "../types";
import type { Machine } from "../../shared/types";
import type { MachineWorktreeLine, MachineWorktreeReport, WorktreeSummary } from "../../shared/worktree-summary";
import { isNodeError, type NodeClient } from "../services/node-client";
import { parsePolicyShape } from "../services/worktree-policy";
import { authorizeNodeWorktreeCall } from "./nodes-worktrees";

export interface MachineWorktreesDeps {
  /** This server's own machine row and its current summary. */
  local: () => { machine: Machine | null; summary: WorktreeSummary | null };
  /** The paired nodes that are Topics servers (not the cloud row). */
  nodes: () => Machine[];
  report: (machineId: string) => MachineWorktreeReport | null;
  tokenOf: (machineId: string) => string | null;
  client: Pick<NodeClient, "putWorktreePolicy" | "worktreeGc">;
}

/** One line per machine: this one first, then the nodes in the store's order. */
export function machineWorktreeLines(deps: MachineWorktreesDeps): MachineWorktreeLine[] {
  const lines: MachineWorktreeLine[] = [];
  const { machine, summary } = deps.local();
  if (machine) {
    lines.push({ machineId: machine.id, name: machine.name, status: machine.status, local: true, supported: true, summary });
  }
  for (const node of deps.nodes()) {
    if (machine && node.id === machine.id) continue;
    const report = deps.report(node.id);
    lines.push({
      machineId: node.id, name: node.name, status: node.status, local: false,
      supported: report ? report.supported : null,
      summary: report?.summary ?? null,
    });
  }
  return lines;
}

export function createMachineWorktreesRouter(ctx: AppContext, deps: () => MachineWorktreesDeps | null): RouteHandler {
  const { json, readJSON, matchRoute } = ctx;

  return async function machineWorktreesRouter(req, url, pathname, method) {
    const isList = pathname === "/api/machines/worktrees";
    const policy = matchRoute(pathname, "/api/machines/:id/worktree-policy");
    const gc = matchRoute(pathname, "/api/machines/:id/worktree-gc");
    if (!isList && !policy && !gc) return null;
    const denied = authorizeNodeWorktreeCall(ctx.db, ctx.requestIdentity?.(req) ?? null);
    if (denied) return json({ error: denied.error, code: denied.code }, denied.status);
    const d = deps();
    if (!d) return json({ error: "worktree reporting not available on this host", code: "unavailable" }, 501);

    if (isList) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ machines: machineWorktreeLines(d) });
    }

    const expected = policy ? "PUT" : "POST";
    if (method !== expected) return json({ error: "method not allowed" }, 405);
    const machineId = (policy ?? gc)!.id;
    // Shape before anything else: an out-of-schema policy never leaves this machine.
    const shape = policy ? parsePolicyShape(await readJSON(req)) : null;
    if (shape && !shape.ok) return json({ error: "invalid worktree policy", code: "invalid_input", errors: shape.errors }, 400);

    const local = d.local().machine;
    if (local?.id === machineId) {
      return json({ error: "this machine's policy is its own settings (PUT /api/app-settings)", code: "local_machine" }, 400);
    }
    const node = d.nodes().find((m) => m.id === machineId);
    if (!node?.baseUrl) return json({ error: "machine not found", code: "not_found" }, 404);
    const supported = d.report(node.id)?.supported ?? null;
    if (supported !== true) return json({ skipped: true, reason: supported === false ? "old-node" : "not-reported" });
    const token = d.tokenOf(node.id);
    if (!token) return json({ error: "no credential for this node", code: "no_token" }, 409);

    try {
      if (shape?.ok) {
        const result = await d.client.putWorktreePolicy({ baseUrl: node.baseUrl, token, policy: shape.policy, dryRun: shape.dryRun });
        return json({ ok: true, ...result });
      }
      const result = await d.client.worktreeGc({ baseUrl: node.baseUrl, token, dryRun: url.searchParams.get("dryRun") === "1" });
      return json({ ok: true, ...result });
    } catch (err) {
      if (!isNodeError(err)) throw err;
      // The node refused the values themselves: the caller fixes the policy, not the network.
      if (err.reason === "rejected") return json({ error: err.message, code: "invalid_input" }, 400);
      return json({ error: err.message, code: err.reason }, 502);
    }
  };
}
