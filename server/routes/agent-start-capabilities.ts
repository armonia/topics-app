import type { AppContext } from "../types";
import { actingPersonId } from "../lib/orgs";
import { subjectRejection } from "../lib/recipients";
import type { SubjectKind } from "../lib/grants-query";
import {
  listAgentStartCapabilities,
  normalizeRepositoryKey,
  putAgentStartCapability,
  revokeAgentStartCapability,
} from "../lib/delegated-agent-start";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { projectIdForPath } from "../../shared/board";
import { availableTaskModels } from "../../shared/task-coding-models";

export interface AgentStartCapabilitiesRouteOpts {
  repositoryKeyOf?: (projectId: string) => Promise<string | null>;
  onCapabilityRevoked?: (capabilityId: string) => Promise<number> | number;
  /** Test seam for the runtime-ready coding catalog. Production uses the shared provider snapshot derivation. */
  taskModels?: () => string[];
}

function isSubjectKind(value: string): value is SubjectKind {
  return value === "device" || value === "person" || value === "org";
}

function devicesForSubject(db: AppContext["db"], kind: SubjectKind, id: string): string[] {
  try {
    if (kind === "device") return [id];
    if (kind === "person") {
      return (db.query("SELECT id FROM devices WHERE person_id = ? AND revoked_at IS NULL").all(id) as Array<{ id: string }>)
        .map((row) => row.id);
    }
    return (db.query(`
      SELECT d.id FROM devices d
        JOIN org_members om ON om.person_id = d.person_id
       WHERE om.org_id = ? AND om.revoked_at IS NULL AND om.local_blocked_at IS NULL
         AND d.revoked_at IS NULL`).all(id) as Array<{ id: string }>).map((row) => row.id);
  } catch {
    return kind === "device" ? [id] : [];
  }
}

function installationOwnerFor(ctx: AppContext, req: Request): string | null {
  const { db } = ctx;
  const identity = ctx.requestIdentity?.(req) ?? null;
  // A non-loopback credential must itself be an owner device. Membership of
  // the owner's person must not promote a guest or delegated credential.
  if (identity !== null && identity.role !== "owner") return null;
  const deviceId = identity?.deviceId ?? null;
  const personId = deviceId
    ? actingPersonId(db as never, deviceId)
    : (db.query("SELECT person_id FROM installation_owners ORDER BY is_default DESC LIMIT 1")
        .get() as { person_id: string } | null)?.person_id ?? null;
  if (!personId) return null;
  return db.query("SELECT 1 FROM installation_owners WHERE person_id = ?").get(personId) ? personId : null;
}

async function repositoryKeyFor(
  ctx: AppContext,
  opts: AgentStartCapabilitiesRouteOpts,
  projectId: string,
): Promise<string | null> {
  if (opts.repositoryKeyOf) return opts.repositoryKeyOf(projectId);
  // Board tasks use the canonical path-derived id, while the catalogue stores
  // its own row id. Both identify the same registered project.
  const direct = ctx.projectStore?.get(projectId) ?? null;
  const canonical = direct ?? ctx.projectStore?.list({ archived: false })
    .find((project) => projectIdForPath(project.path) === projectId) ?? null;
  const path = canonical?.path;
  if (!path) return null;
  const proc = Bun.spawn(["git", "-C", path, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? normalizeRepositoryKey(output) : null;
}

/** Project-owner administration of the capability to start an agent. */
export async function routeAgentStartCapabilities(
  ctx: AppContext,
  opts: AgentStartCapabilitiesRouteOpts,
  req: Request,
  url: URL,
  method: string,
  now: number,
): Promise<Response | null> {
  const { db, json, readJSON } = ctx;
  const ownerPersonId = installationOwnerFor(ctx, req);
  if (!ownerPersonId) return json({ error: "installation owner required", code: "owner_required" }, 403);

  if (method === "GET") {
    const projectId = url.searchParams.get("projectId") ?? "";
    if (!projectId) return json({ error: "projectId required", code: "invalid_input" }, 400);
    const capabilities = listAgentStartCapabilities(db as never, projectId);
    const repositoryKey = await repositoryKeyFor(ctx, opts, projectId);
    const machines = db.query("SELECT id, name, status, base_url FROM machines ORDER BY name")
      .all() as Array<{ id: string; name: string; status: string; base_url: string | null }>;
    const taskModels = opts.taskModels?.()
      ?? availableTaskModels(getSnapshotManager().getSnapshot());
    let projectModel: string | null = null;
    try {
      const row = db.query("SELECT dispatch_model FROM board_settings WHERE project_id = ?")
        .get(projectId) as { dispatch_model: string | null } | null;
      if (row?.dispatch_model && taskModels.includes(row.dispatch_model)) projectModel = row.dispatch_model;
    } catch { /* A reduced schema can still list existing capabilities. */ }
    const modelOptions = taskModels.map((id) => ({ id }));
    const computers = machines.map((machine) => {
      let remoteModels: Array<{ id: string }> = [];
      let remoteCatalogVerified = false;
      if (machine.base_url !== null && repositoryKey) {
        try {
          const catalog = db.query(`SELECT models_json FROM machine_delegated_model_catalogs
            WHERE machine_id=? AND repository_key=? AND revoked_at IS NULL AND expires_at>?`)
            .get(machine.id, repositoryKey, now) as { models_json: string } | null;
          const parsed = catalog ? JSON.parse(catalog.models_json) : [];
          if (catalog && Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
            remoteCatalogVerified = true;
            remoteModels = parsed.map((id: string) => ({ id }));
          }
        } catch { /* Migration not present in reduced/older schemas: unverified is fail-closed. */ }
      }
      return {
        id: machine.id,
        name: machine.name,
        remote: machine.base_url !== null,
        repositoryKey,
        repositoryName: repositoryKey?.split("/").at(-1) ?? null,
        available: !!repositoryKey && (machine.base_url === null || !!db.query(
          `SELECT 1 FROM machine_repository_authorizations
            WHERE machine_id = ? AND repository_key = ? AND revoked_at IS NULL`,
        ).get(machine.id, repositoryKey)),
        modelSupport: machine.base_url === null || remoteCatalogVerified ? "verified" : "unverified",
        models: machine.base_url === null ? modelOptions : remoteModels,
      };
    });
    const machineById = new Map(machines.map((machine) => [machine.id, machine]));
    const computerById = new Map(computers.map((computer) => [computer.id, computer]));
    const listedCapabilities = capabilities.map((capability) => {
      const machine = machineById.get(capability.machineId);
      const modelAvailability = !machine
        ? "unavailable"
        : machine.base_url === null
          ? taskModels.includes(capability.model) ? "available" : "unavailable"
          : computerById.get(machine.id)?.modelSupport === "verified"
            ? computerById.get(machine.id)!.models.some((entry) => entry.id === capability.model)
              ? "available"
              : "unavailable"
            : "unverified";
      return { ...capability, modelAvailability };
    });
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const durationsMinutes = [15, 30, 60, 120];
    return json({
      capabilities: listedCapabilities,
      computers,
      models: modelOptions,
      recommendedModel: projectModel,
      efforts,
      durationsMinutes,
      policyOptions: {
        machines: computers,
        models: modelOptions,
        efforts,
        durationsMinutes,
      },
    });
  }

  if (method === "POST") {
    const body = await readJSON(req) as Record<string, unknown> | null;
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const subjectType = body?.subjectType;
    const subjectId = typeof body?.subjectId === "string" ? body.subjectId : "";
    const machineId = typeof body?.machineId === "string" ? body.machineId : "";
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const effort = typeof body?.effort === "string" ? body.effort.trim() : "";
    const maxDurationMinutes = body?.maxDurationMinutes;
    if (!projectId || !subjectId || !machineId || !model || !effort
      || typeof subjectType !== "string" || !isSubjectKind(subjectType)
      || typeof maxDurationMinutes !== "number" || !Number.isInteger(maxDurationMinutes)
      || maxDurationMinutes < 1 || maxDurationMinutes > 1440) {
      return json({ error: "invalid capability policy", code: "invalid_input" }, 400);
    }
    const rejection = subjectRejection(db as never, subjectType, subjectId);
    if (rejection) return json({ error: rejection.codice }, rejection.status);
    const machine = db.query("SELECT base_url FROM machines WHERE id = ?").get(machineId) as {
      base_url: string | null;
    } | null;
    if (!machine) return json({ error: "machine not found", code: "machine_not_found" }, 404);
    const repositoryKey = await repositoryKeyFor(ctx, opts, projectId);
    if (!repositoryKey) return json({ error: "project repository unresolved", code: "repository_unresolved" }, 409);
    const taskModels = opts.taskModels?.()
      ?? availableTaskModels(getSnapshotManager().getSnapshot());
    let allowedModels = taskModels;
    let remoteCatalogVerified = machine.base_url === null;
    if (machine.base_url !== null) {
      try {
        const catalog = db.query(`SELECT models_json FROM machine_delegated_model_catalogs
          WHERE machine_id=? AND repository_key=? AND revoked_at IS NULL AND expires_at>?`)
          .get(machineId, repositoryKey, now) as { models_json: string } | null;
        allowedModels = catalog ? JSON.parse(catalog.models_json) : [];
        remoteCatalogVerified = !!catalog && Array.isArray(allowedModels)
          && allowedModels.every((item) => typeof item === "string");
      } catch { allowedModels = []; }
      if (!Array.isArray(allowedModels) || !allowedModels.every((item) => typeof item === "string")) allowedModels = [];
      if (!remoteCatalogVerified) {
        return json({ error: "remote machine model catalog unverified", code: "model_catalog_unverified" }, 409);
      }
    }
    if (!allowedModels.includes(model)) {
      return json({ error: "coding model unavailable", code: "model_unavailable" }, 409);
    }
    const replaced = listAgentStartCapabilities(db as never, projectId).find((candidate) =>
      candidate.subjectType === subjectType && candidate.subjectId === subjectId && candidate.revokedAt === null);
    const capability = putAgentStartCapability(db as never, {
      subjectType, subjectId, projectId, machineId, repositoryKey, model, effort,
      maxDurationMinutes, grantedByPersonId: ownerPersonId, now,
    });
    if (replaced) await opts.onCapabilityRevoked?.(replaced.id);
    for (const deviceId of devicesForSubject(db, subjectType, subjectId)) {
      ctx.sendToDevice?.(deviceId, { type: "auth:shares-changed" });
    }
    return json({ capability }, 201);
  }

  if (method === "DELETE") {
    const projectId = url.searchParams.get("projectId") ?? "";
    const capabilityId = url.searchParams.get("capabilityId") ?? "";
    if (!projectId || !capabilityId) {
      return json({ error: "projectId and capabilityId required", code: "invalid_input" }, 400);
    }
    const existing = listAgentStartCapabilities(db as never, projectId).find((candidate) => candidate.id === capabilityId);
    if (!existing) return json({ error: "capability not found", code: "not_found" }, 404);
    if (!revokeAgentStartCapability(db as never, { capabilityId, projectId, revokedByPersonId: ownerPersonId, now })) {
      return json({ error: "capability already revoked", code: "already_revoked" }, 409);
    }
    const canceledRuns = await opts.onCapabilityRevoked?.(capabilityId) ?? 0;
    for (const deviceId of devicesForSubject(db, existing.subjectType, existing.subjectId)) {
      ctx.sendToDevice?.(deviceId, { type: "auth:shares-changed" });
    }
    return json({ ok: true, canceledRuns });
  }

  return null;
}
