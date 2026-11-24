/**
 * The worktree policy a primary sends its node (change worktree-standard, T12).
 *
 * The node reports, the primary decides, the node executes: the values land in
 * the node's own `app_settings`, so a node never configured keeps the defaults
 * and works empty. A policy is checked twice on purpose: its SHAPE here (known
 * keys only, a boolean `dryRun`), its VALUES by the same rules as
 * `PUT /api/app-settings` on the machine that applies it, because a root is a
 * path of that machine (`E:\wt` is absolute on Windows, not on the primary).
 * The same holds for the root's safety: the node refuses its OWN home, a folder
 * holding its projects or a non-empty folder without Topics' sentinel, judged on
 * its own disk. The primary cannot widen what the node's cleanup may look at.
 */
import { WORKTREE_POLICY_FIELDS, type WorktreePolicy, type WorktreePolicyKey } from "../../shared/worktree-summary";
import type { AppSettings } from "./app-settings";

/** `code` names why a root was refused (`WorktreeRootRefusal`), so the primary can say it. */
export type PolicyError = { field: string; message: string; code?: string };

export type ParsedPolicyShape =
  | { ok: true; policy: WorktreePolicy; dryRun: boolean }
  | { ok: false; errors: PolicyError[] };

const KEYS = Object.keys(WORKTREE_POLICY_FIELDS) as WorktreePolicyKey[];

/** Shape only: an object, known keys, scalar values, `dryRun` boolean, at least one field. */
export function parsePolicyShape(body: unknown): ParsedPolicyShape {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "", message: "body must be a JSON object" }] };
  }
  const errors: PolicyError[] = [];
  const policy: WorktreePolicy = {};
  let dryRun = false;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "dryRun") {
      if (typeof value !== "boolean") errors.push({ field: key, message: "expected a boolean" });
      else dryRun = value;
      continue;
    }
    if (!(KEYS as string[]).includes(key)) {
      errors.push({ field: key, message: `unknown field; expected one of: ${KEYS.join(", ")}` });
      continue;
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      errors.push({ field: key, message: "expected a string, a number or null" });
      continue;
    }
    policy[key as WorktreePolicyKey] = value;
  }
  if (errors.length === 0 && Object.keys(policy).length === 0) {
    errors.push({ field: "", message: `no policy field; expected one of: ${KEYS.join(", ")}` });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy, dryRun };
}

/** The policy as an `app_settings` patch body, field by field. */
export function policyToSettingsBody(policy: WorktreePolicy): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (key in policy) body[WORKTREE_POLICY_FIELDS[key]] = policy[key];
  }
  return body;
}

/** The values the node holds now for the policy fields, by wire name (for a dry run to show before/after). */
export function currentPolicy(settings: Partial<AppSettings>): WorktreePolicy {
  const out: WorktreePolicy = {};
  for (const key of KEYS) {
    const v = (settings as Record<string, unknown>)[WORKTREE_POLICY_FIELDS[key]];
    out[key] = typeof v === "string" || typeof v === "number" ? v : null;
  }
  return out;
}

/** Error fields renamed back to the wire names the caller sent. */
export function policyErrors(errors: PolicyError[]): PolicyError[] {
  const back = new Map<string, string>(KEYS.map((k) => [WORKTREE_POLICY_FIELDS[k], k]));
  return errors.map((e) => ({ field: back.get(e.field) ?? e.field, message: e.message, ...(e.code ? { code: e.code } : {}) }));
}
