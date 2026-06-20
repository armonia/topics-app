/**
 * ui-state route (v2 envelope — Phase 30 PANE-01/02/04).
 *
 * Single-key GET: returns { value, payload_version, server_seq }.
 * All-keys GET + ui-state:init WS frame: returns { data: { key → value }, meta: { key → { payload_version, server_seq } } }.
 *   - BACKWARD-COMPATIBLE: data[key] preserves the legacy parsed-value shape, so non-pane
 *     consumers (useSidebarState, useServerState) keep working unchanged.
 *   - Pane-store middleware (client/src/state/pane/middleware/syncWS.ts) reads meta[key].server_seq
 *     for LWW conflict resolution.
 *
 * Writes: always stamp payload_version=2 and allocate a fresh server_seq via
 *         MAX(server_seq)+1 inside a transaction. Broadcast ui-state:updated with
 *         server_seq at the top level (additive; non-breaking).
 *
 * Hardening (Bug #6, Bug #7):
 *   - Body size cap (MAX_UI_STATE_BYTES) enforced on single + bulk.
 *   - Shape validation: reject arrays/primitives/null, reject bulk with non-object values.
 *   - Server-side strip of device-local scrollOffset fields — defense-in-depth
 *     against a misbehaving client that leaks them back.
 *   - Hard-fail (500) if payload_version / server_seq columns return null/undefined —
 *     that means migration 012 was never applied and we MUST NOT silently coalesce.
 */
import type { AppContext, RouteHandler } from "../types";

type UiStateMeta = { payload_version: number; server_seq: number };
type UiStateEnvelope = { data: Record<string, unknown>; meta: Record<string, UiStateMeta> };

/**
 * Max accepted JSON body size for a single ui-state PUT. 256 KB is >>10x the
 * p99 pane-snapshot size observed (~8 KB) and leaves ample headroom for growth
 * while still making a DoS attempt (e.g. 1 MB blob spam) cheap to reject.
 *
 * For the bulk PUT: same cap applies to the whole body AND to every individual
 * value — a bulk caller cannot smuggle a 256 KB blob under a single key past
 * what a single-key PUT would permit.
 */
export const MAX_UI_STATE_BYTES = 256 * 1024;

/**
 * Recursively strip device-local fields from a payload before persistence.
 *
 * The authoritative stripper lives client-side in
 * `client/src/state/pane/selectors.ts#selectSyncableSnapshot`, which removes
 * `scrollOffset` from:
 *   - top-level `panes.*.scrollOffset`
 *   - nested `projects.*.panes.*.scrollOffset`
 *   - nested `closedStack.*.pane.scrollOffset` (the OUTER
 *     `closedStack.*.scrollOffset` is intentionally synced for undo fidelity —
 *     see PANE-03 / sanitizeSnapshot.ts notes)
 *
 * This helper is defense-in-depth: even if a bugged or adversarial client
 * leaks `scrollOffset` back, we don't persist it.
 *
 * IMPORTANT: we only strip the specific nested locations we know about, NOT
 * every key named `scrollOffset` everywhere — that would break unrelated
 * consumer state that happens to use the same field name.
 */
export function stripDeviceLocalFields(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  // Shallow clone so we don't mutate caller data.
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

  // top-level panes.*.scrollOffset
  if (out.panes && typeof out.panes === "object" && !Array.isArray(out.panes)) {
    const panes = out.panes as Record<string, unknown>;
    const cleanPanes: Record<string, unknown> = {};
    for (const [id, p] of Object.entries(panes)) {
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const { scrollOffset: _drop, ...rest } = p as Record<string, unknown>;
        cleanPanes[id] = rest;
      } else {
        cleanPanes[id] = p;
      }
    }
    out.panes = cleanPanes;
  }

  // projects.*.panes.*.scrollOffset
  if (out.projects && typeof out.projects === "object" && !Array.isArray(out.projects)) {
    const projects = out.projects as Record<string, unknown>;
    const cleanProjects: Record<string, unknown> = {};
    for (const [pkey, layout] of Object.entries(projects)) {
      if (layout && typeof layout === "object" && !Array.isArray(layout)) {
        const layoutObj = { ...(layout as Record<string, unknown>) };
        if (layoutObj.panes && typeof layoutObj.panes === "object" && !Array.isArray(layoutObj.panes)) {
          const nestedPanes = layoutObj.panes as Record<string, unknown>;
          const cleanNested: Record<string, unknown> = {};
          for (const [id, p] of Object.entries(nestedPanes)) {
            if (p && typeof p === "object" && !Array.isArray(p)) {
              const { scrollOffset: _drop, ...rest } = p as Record<string, unknown>;
              cleanNested[id] = rest;
            } else {
              cleanNested[id] = p;
            }
          }
          layoutObj.panes = cleanNested;
        }
        cleanProjects[pkey] = layoutObj;
      } else {
        cleanProjects[pkey] = layout;
      }
    }
    out.projects = cleanProjects;
  }

  // closedStack.*.pane.scrollOffset (inner pane only — outer record.scrollOffset is SYNCED)
  if (Array.isArray(out.closedStack)) {
    out.closedStack = (out.closedStack as unknown[]).map((rec) => {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) return rec;
      const recObj = { ...(rec as Record<string, unknown>) };
      if (recObj.pane && typeof recObj.pane === "object" && !Array.isArray(recObj.pane)) {
        const { scrollOffset: _drop, ...paneRest } = recObj.pane as Record<string, unknown>;
        recObj.pane = paneRest;
      }
      return recObj;
    });
  }

  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Throws 500-flavoured Error if row indicates migration 012 has not been
 * applied. Coalescing `?? 1` / `?? 0` masked this silently; we now fail loud.
 */
function assertMigration012(row: { payload_version: unknown; server_seq: unknown } | null | undefined, ctx: string): void {
  if (!row) return; // null row is a legitimate "not found"
  if (row.payload_version === undefined || row.payload_version === null) {
    throw new Error(
      `[ui-state/${ctx}] migration 012 not applied — payload_version column missing. Run \`bun run db:migrate\`.`,
    );
  }
  if (row.server_seq === undefined || row.server_seq === null) {
    throw new Error(
      `[ui-state/${ctx}] migration 012 not applied — server_seq column missing. Run \`bun run db:migrate\`.`,
    );
  }
}

export function createUiStateRouter(ctx: AppContext): RouteHandler {
  const { db, json, broadcastToAll } = ctx;

  function getAllUiStateEnvelope(): UiStateEnvelope {
    const rows = db.query("SELECT key, value, payload_version, server_seq FROM ui_state").all() as { key: string; value: string; payload_version: number; server_seq: number }[];
    const data: Record<string, unknown> = {};
    const meta: Record<string, UiStateMeta> = {};
    for (const row of rows) {
      assertMigration012(row, "GET-all");
      try { data[row.key] = JSON.parse(row.value); } catch { data[row.key] = row.value; }
      meta[row.key] = { payload_version: row.payload_version, server_seq: row.server_seq };
    }
    return { data, meta };
  }

  return async function uiStateRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/ui-state — all keys (Option-A envelope: { data, meta })
    if (method === "GET" && pathname === "/api/ui-state") {
      try {
        return json(getAllUiStateEnvelope());
      } catch (err: any) {
        console.error("[ui-state] GET all failed:", err);
        return json({ error: err?.message ?? "internal error" }, 500);
      }
    }

    // GET /api/ui-state/:key — single-key envelope { value, payload_version, server_seq }
    const getMatch = method === "GET" && pathname.match(/^\/api\/ui-state\/([^/]+)$/);
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1]);
      const row = db.query("SELECT value, payload_version, server_seq FROM ui_state WHERE key = ?").get(key) as { value: string; payload_version: number; server_seq: number } | null;
      if (!row) return json(null);
      try {
        assertMigration012(row, "GET-single");
      } catch (err: any) {
        console.error("[ui-state] GET single failed:", err);
        return json({ error: err.message }, 500);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
      return json({ value: parsed, payload_version: row.payload_version, server_seq: row.server_seq });
    }

    // PUT /api/ui-state/:key — single key update (stamps payload_version=2, increments server_seq)
    const putMatch = method === "PUT" && pathname.match(/^\/api\/ui-state\/([^/]+)$/);
    if (putMatch) {
      const key = decodeURIComponent(putMatch[1]);
      // Finding #10: the client tags every write with a per-tab identifier (the
      // `X-Client-Id` header, populated by syncServer.ts from syncCrossTab.getTabId()).
      // We echo it back on the broadcast as `sourceClientId` so syncWS.ts can
      // suppress HYDRATE frames that originated on this tab — defence-in-depth
      // on top of the `rememberLocalAck`/`isSelfEcho` ack-based filter, covering
      // the case where the ack is lost (crash mid-PUT, reconnect) while the
      // broadcast still lands. `?cid=` query param is accepted too so
      // `navigator.sendBeacon` (which can't set custom headers) can still
      // identify itself on `pagehide`.
      const headerCid = req.headers.get("x-client-id");
      const queryCid = _url.searchParams.get("cid");
      // Coerce to undefined (not null): the outbound contract is
      // `sourceClientId: z.string().optional()`, which accepts undefined but
      // REJECTS null. `searchParams.get`/`headers.get` return null when absent,
      // so a write with no client id (e.g. a server-internal or header-less API
      // PUT) would otherwise emit a contract-violating broadcast.
      const sourceClientId = (headerCid && headerCid.length > 0 ? headerCid : queryCid) || undefined;
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      // Shape: must be a plain object (arrays, primitives, null rejected).
      if (!isPlainObject(body)) {
        return json({ error: "Body must be a JSON object" }, 400);
      }

      // Defense-in-depth: strip device-local scrollOffset before persistence.
      const sanitized = stripDeviceLocalFields(body);
      const value = JSON.stringify(sanitized);

      // Size cap: measured on the serialized-to-be-stored payload.
      if (value.length > MAX_UI_STATE_BYTES) {
        return json({ error: `Payload exceeds ${MAX_UI_STATE_BYTES} bytes`, limit: MAX_UI_STATE_BYTES, size: value.length }, 413);
      }

      // Race-fix (Phase 30): use BEGIN IMMEDIATE instead of the default
      // BEGIN DEFERRED that bun:sqlite's db.transaction() emits. Two concurrent
      // PUT callers with DEFERRED can both execute the SELECT MAX before either
      // takes the write lock, see the same max, and collide on seq allocation.
      // IMMEDIATE acquires a RESERVED lock at BEGIN time, so a second writer
      // blocks until the first commits and then reads the updated MAX —
      // guaranteeing distinct, monotonically increasing server_seq values.
      const server_seq = db.transaction(() => {
        const { maxSeq } = db.query(
          "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
        ).get() as { maxSeq: number };
        const nextSeq = maxSeq + 1;
        db.run(
          `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
           VALUES (?, ?, 2, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             payload_version = 2,
             server_seq = excluded.server_seq,
             updated_at = datetime('now')`,
          [key, value, nextSeq],
        );
        return nextSeq;
      }).immediate();

      broadcastToAll({ type: "ui-state:updated", key, value: sanitized, payload_version: 2, server_seq, sourceClientId });
      return json({ ok: true, payload_version: 2, server_seq });
    }

    // PUT /api/ui-state — bulk update (each key stamped v2 with fresh server_seq in one txn)
    if (method === "PUT" && pathname === "/api/ui-state") {
      // Finding #10: same client-id propagation contract as the single-key PUT.
      const headerCid = req.headers.get("x-client-id");
      const queryCid = _url.searchParams.get("cid");
      // Coerce to undefined (not null): the outbound contract is
      // `sourceClientId: z.string().optional()`, which accepts undefined but
      // REJECTS null. `searchParams.get`/`headers.get` return null when absent,
      // so a write with no client id (e.g. a server-internal or header-less API
      // PUT) would otherwise emit a contract-violating broadcast.
      const sourceClientId = (headerCid && headerCid.length > 0 ? headerCid : queryCid) || undefined;
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      // Shape: must be { [key: string]: object }. Arrays/primitives/null rejected
      // at the root AND for every value.
      if (!isPlainObject(body)) {
        return json({ error: "Body must be a JSON object mapping key → object" }, 400);
      }
      for (const [k, v] of Object.entries(body)) {
        if (typeof k !== "string" || k.length === 0) {
          return json({ error: "Bulk keys must be non-empty strings" }, 400);
        }
        if (!isPlainObject(v)) {
          return json({ error: `Bulk value for key "${k}" must be a JSON object` }, 400);
        }
      }

      // Strip device-local fields per value, then size-check both totals and per-key.
      const cleaned: Record<string, { sanitized: unknown; serialized: string }> = {};
      let totalSize = 0;
      for (const [k, v] of Object.entries(body)) {
        const sanitized = stripDeviceLocalFields(v);
        const serialized = JSON.stringify(sanitized);
        if (serialized.length > MAX_UI_STATE_BYTES) {
          return json({ error: `Payload for key "${k}" exceeds ${MAX_UI_STATE_BYTES} bytes`, limit: MAX_UI_STATE_BYTES, size: serialized.length, key: k }, 413);
        }
        totalSize += serialized.length;
        if (totalSize > MAX_UI_STATE_BYTES) {
          return json({ error: `Total bulk payload exceeds ${MAX_UI_STATE_BYTES} bytes`, limit: MAX_UI_STATE_BYTES, size: totalSize }, 413);
        }
        cleaned[k] = { sanitized, serialized };
      }

      // Race-fix (Phase 30): BEGIN IMMEDIATE — same rationale as the single-key
      // path above.
      const server_seqs: Record<string, number> = {};
      const run = db.transaction(() => {
        const current = (db.query(
          "SELECT COALESCE(MAX(server_seq), 0) AS maxSeq FROM ui_state",
        ).get() as { maxSeq: number }).maxSeq;
        let i = 0;
        for (const [key, { serialized }] of Object.entries(cleaned)) {
          const nextSeq = current + (++i);
          db.run(
            `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
             VALUES (?, ?, 2, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               payload_version = 2,
               server_seq = excluded.server_seq,
               updated_at = datetime('now')`,
            [key, serialized, nextSeq],
          );
          server_seqs[key] = nextSeq;
        }
      });
      run.immediate();

      // Finding #11: broadcast a DELTA (`ui-state:patch`) that only carries the
      // keys this request actually modified, instead of the full `ui-state:init`
      // snapshot. Fan-out for a bulk PUT of N keys to M connected clients was
      // O(N × totalKeys × M) — here it's O(N × M), and more importantly the
      // per-client payload size is proportional to the write, not to the
      // whole `ui_state` table. This keeps us inside the 300ms cross-tab
      // target declared in performance/spec.md even for large snapshots.
      //
      // Back-compat: initial WS-open push still uses `ui-state:init` (see
      // handleOpen in server.ts / utils.ts), so older clients that don't
      // implement `ui-state:patch` continue receiving their init frame and
      // simply ignore the subsequent patch events. The single-key PUT path
      // also keeps broadcasting `ui-state:updated` unchanged — patch is a new
      // additive shape, not a replacement for the existing ones.
      try {
        const entries: Record<string, { data: unknown; payload_version: number; server_seq: number }> = {};
        for (const [k, { sanitized }] of Object.entries(cleaned)) {
          entries[k] = { data: sanitized, payload_version: 2, server_seq: server_seqs[k] };
        }
        broadcastToAll({ type: "ui-state:patch", sourceClientId, entries });
      } catch (err: any) {
        // Broadcast failure is non-fatal for the write (DB txn already
        // committed). Surface it — callers relying on the WS will refetch.
        console.error("[ui-state] bulk PUT broadcast failed:", err);
        return json({ error: err?.message ?? "internal error" }, 500);
      }
      return json({ ok: true, server_seqs });
    }

    return null;
  };
}

/** Helper to load all ui_state for WS init push — returns Option-A envelope { data, meta }. */
export function loadAllUiState(db: import("bun:sqlite").Database): UiStateEnvelope {
  try {
    const rows = db.query("SELECT key, value, payload_version, server_seq FROM ui_state").all() as { key: string; value: string; payload_version: number; server_seq: number }[];
    const data: Record<string, unknown> = {};
    const meta: Record<string, UiStateMeta> = {};
    for (const row of rows) {
      // Don't throw on WS init path — log and coerce, since a thrown error here
      // would take down the WS open handler for every new client. The boot-time
      // check in server.ts is the authoritative gate.
      if (row.payload_version === undefined || row.payload_version === null) {
        console.error(`[ui-state] loadAllUiState: migration 012 not applied (key=${row.key}) — clients will see degraded meta.`);
      }
      try { data[row.key] = JSON.parse(row.value); } catch { data[row.key] = row.value; }
      meta[row.key] = {
        payload_version: row.payload_version ?? 1,
        server_seq: row.server_seq ?? 0,
      };
    }
    return { data, meta };
  } catch {
    return { data: {}, meta: {} };
  }
}

/**
 * Boot-time guard (Bug #7): hard-fail startup if migration 012 never ran.
 *
 * Checks the `ui_state` table schema for the `payload_version` column. If
 * absent, throws — the caller (server.ts) lets the error propagate and exit(1).
 *
 * Call this AFTER `initDatabase()` so migrations have had their chance to run.
 * With a healthy DB, migration 012 runs automatically and this check passes.
 * Without it (e.g. someone pinned to an older migrations dir), we fail loud
 * instead of silently degrading every GET/PUT.
 */
export function assertUiStateMigrationApplied(db: import("bun:sqlite").Database): void {
  const tableRow = db.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ui_state'",
  ).get() as { sql: string } | null;
  if (!tableRow || !tableRow.sql) {
    throw new Error("[ui-state] boot check: ui_state table missing — migrations did not run. Run `bun run db:migrate`.");
  }
  if (!/payload_version/i.test(tableRow.sql)) {
    throw new Error("[ui-state] boot check: migration 012 not applied — payload_version column missing. Run `bun run db:migrate`.");
  }
  if (!/server_seq/i.test(tableRow.sql)) {
    throw new Error("[ui-state] boot check: migration 012 not applied — server_seq column missing. Run `bun run db:migrate`.");
  }
}
