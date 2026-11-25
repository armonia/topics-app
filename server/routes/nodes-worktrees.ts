/**
 * Routes: the worktrees of THIS machine as its primary sees them (change
 * worktree-standard, track T12). They run ON THE NODE, next to `/api/nodes/runs`.
 *
 *   GET  /api/nodes/worktrees[?list=1]        the summary (and, on request, the folders)
 *   PUT  /api/nodes/worktree-policy           the policy, into this machine's settings (`dryRun` = preview)
 *   POST /api/nodes/worktrees/gc[?dryRun=1]   one cleanup pass now, or its preview
 *
 * The node reports, the primary decides the policy, the node executes with the
 * facts only it has (dirty trees, live cwds, locks). Nothing here deletes a path
 * it was sent: the only removal is the node's own cleanup pass, under its own
 * safety contract. Never an `rm` from remote.
 *
 * WHO: the credential of the primary that holds this node's channel, or this
 * machine's owner. A delegated credential is refused even when it would pass
 * every other check: it is scoped to one run of one repository, not to the
 * machine's disk.
 */
import type { Database } from "bun:sqlite";
import type { AppContext, RouteHandler } from "../types";
import type { WorktreePlanPayload } from "../../shared/worktree-plan";
import type { AppSettings } from "../services/app-settings";
import type { WorktreeSummarySource } from "../services/worktree-summary";
import { currentPolicy, parsePolicyShape, policyErrors, policyToSettingsBody, type PolicyError } from "../services/worktree-policy";
import { guardNodesCall } from "../lib/primary-role";
import { isNodeDevice, mayDriveNodeRuns } from "../lib/node-scope";

export const NODE_WORKTREES_PATH = "/api/nodes/worktrees";
export const NODE_WORKTREE_POLICY_PATH = "/api/nodes/worktree-policy";
export const NODE_WORKTREES_GC_PATH = "/api/nodes/worktrees/gc";

/** What the node side needs from the server; built in the boot so the routes stay testable. */
export interface NodeWorktreesDeps {
  summary: WorktreeSummarySource;
  /** The cleanup preview without weights: what the next pass would do, nothing written. */
  plan: () => Promise<WorktreePlanPayload | null>;
  /** One cleanup pass, now. */
  runGc: () => Promise<unknown>;
  /** This machine's settings as stored. */
  settings: () => Partial<AppSettings>;
  /** The `PUT /api/app-settings` validation, with this machine's projects. */
  validate: (body: Record<string, unknown>) => { patch: Partial<AppSettings>; errors: PolicyError[] };
  /** Writes the validated patch into this machine's settings. */
  apply: (patch: Partial<AppSettings>) => void;
}

type RequestIdentity = ReturnType<NonNullable<AppContext["requestIdentity"]>>;

/**
 * May this caller read or steer this machine's worktrees? Checked before
 * anything is read or written. A delegated credential first: it may carry an
 * owner role in a test or a future gate, and it must still be refused.
 */
export function authorizeNodeWorktreeCall(
  db: Pick<Database, "query">,
  identity: RequestIdentity,
): { status: 403; error: string; code: string } | null {
  if (identity?.delegatedAuthorizationId) {
    return { status: 403, error: "a delegated credential cannot reach this machine's worktrees", code: "delegated_scope" };
  }
  // No identity resolved means the gate let the request through as the owner (kill switch,
  // loopback): the same reading every role-filtering route gives it (`AppContext.requestIdentity`).
  if (!identity) return null;
  if (identity.role !== "owner") return { status: 403, error: "not available to a guest", code: "guest_forbidden" };
  if (identity.deviceId && isNodeDevice(db, identity.deviceId) && !mayDriveNodeRuns(db, identity.deviceId)) {
    return { status: 403, error: "only the primary holding this node's channel steers its worktrees", code: "node_scope" };
  }
  return null;
}

const HANDLED = new Set([NODE_WORKTREES_PATH, NODE_WORKTREE_POLICY_PATH, NODE_WORKTREES_GC_PATH]);

export function createNodeWorktreesRouter(ctx: AppContext, deps: () => NodeWorktreesDeps | null): RouteHandler {
  const { json, readJSON } = ctx;

  return async function nodeWorktreesRouter(req, url, pathname, method) {
    if (!HANDLED.has(pathname)) return null;
    const identity = ctx.requestIdentity?.(req) ?? null;
    const denied = authorizeNodeWorktreeCall(ctx.db, identity);
    if (denied) return json({ error: denied.error, code: denied.code }, denied.status);
    const stale = guardNodesCall(req, identity);
    if (stale) return stale;
    const d = deps();
    if (!d) return json({ error: "worktree reporting not available on this host", code: "unavailable" }, 501);

    if (pathname === NODE_WORKTREES_PATH) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      const summary = d.summary.current();
      return json({
        worktreeStandard: 1,
        summary,
        ...(url.searchParams.get("list") === "1" ? { entries: d.summary.entries() } : {}),
      });
    }

    if (pathname === NODE_WORKTREES_GC_PATH) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      if (url.searchParams.get("dryRun") === "1") {
        const plan = await d.plan();
        return plan ? json({ dryRun: true, plan }) : json({ error: "the preview could not be built", code: "internal" }, 500);
      }
      const result = await d.runGc();
      d.summary.invalidate();
      return json({ ok: true, result });
    }

    if (method !== "PUT") return json({ error: "method not allowed" }, 405);
    const shape = parsePolicyShape(await readJSON(req));
    if (!shape.ok) return json({ error: "invalid worktree policy", code: "invalid_input", errors: shape.errors }, 400);
    const { patch, errors } = d.validate(policyToSettingsBody(shape.policy));
    if (errors.length > 0) {
      return json({ error: "invalid worktree policy", code: "invalid_input", errors: policyErrors(errors) }, 400);
    }
    const before = currentPolicy(d.settings());
    if (shape.dryRun) {
      return json({ ok: true, dryRun: true, before, after: currentPolicy({ ...d.settings(), ...patch }) });
    }
    d.apply(patch);
    d.summary.invalidate();
    return json({ ok: true, before, after: currentPolicy(d.settings()) });
  };
}
