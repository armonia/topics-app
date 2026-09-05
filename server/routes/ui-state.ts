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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectPathTokensIn } from "../services/known-project-dirs";
import { clientProjectPathRefused, CLIENT_PROJECT_PATH_ERROR } from "../lib/client-project-path";

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

/** The `ui_state` key holding the app preferences (client: `SETTINGS_SERVER_KEY`). */
export const SETTINGS_KEY = "settings";

/** The pane store key (client: `middleware/syncServer.ts#REMOTE_KEY`).
 *  The only one that carries tombstones, so the only one a cascade is born from. */
export const PANE_STORE_KEY = "pane-store-v2";

export interface UiStateRouterOptions {
  /**
   * The consequences of a closed tab, decided on the BEFORE and the AFTER of the
   * snapshot (`services/pane-retirement-cascade.ts` decides, the caller applies).
   * Called only for `pane-store-v2` and only once the write has COMMITTED: a
   * cascade on a write the CAS gate then rejected would have archived chats for a
   * snapshot the server threw away.
   *
   * Absent ⇒ the router behaves exactly as before (tests, fixtures).
   */
  onPaneSnapshot?: (prev: unknown, next: unknown) => void;
}

/** The `AppSettings` fields that stay on THIS device — twins of
 *  `DEVICE_LOCAL_SETTING_KEYS` in `client/src/lib/settings.ts`. */
export const DEVICE_LOCAL_SETTINGS_FIELDS = ["sidebarWidth", "sidebarCollapsed"] as const;

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
/**
 * THE FOLDER IS ONE, EVEN IF THE PANE CALLS IT BY TWO NAMES.
 *
 * A project reached by two roads (a symlink, a different capitalisation, a moved
 * folder) yields two entries. Server-side merging joined them in the DB, but the
 * client kept pushing its own `pane-store-v2` back from localStorage and the
 * duplicate returned: cleaned at 08:06, back there at 09:19. Cleaning the server
 * while the client rewrites is a lap for nothing, so normalisation sits WHERE THE
 * WRITE HAPPENS.
 *
 * And it REMAPS, it does not delete. The first version just dropped the pane, and
 * that was not enough: the old pane was gone from `panes` but its id was still
 * inside `groups.*.paneIds`, i.e. the tab strip — the second entry on screen was
 * that one. Remapping keeps the tab and points it at the real project; deleting
 * would have left a tab pointing at nothing.
 *
 * The condition: we touch ONLY a path that no longer exists and that has a twin
 * in `~/Projects`. Without it, an unmounted external disk would lose its panes —
 * real damage to fix an annoyance.
 */
export function dropVanishedProjectPanes(payload: unknown, key?: string): unknown {
  if (key !== "pane-store-v2" || !payload || typeof payload !== "object") return payload;

  const PREFIX = "project:";
  const twinOf = (p: string): string | null => {
    if (existsSync(p)) return null;
    const c = join(homedir(), "Projects", p.split("/").filter(Boolean).pop() || "");
    return c !== p && existsSync(c) ? c : null;
  };
  // id → id: computed once, then rewritten everywhere it shows up.
  const idMap = new Map<string, string>();
  const collect = (s: string) => {
    if (idMap.has(s)) return;
    if (s.startsWith(PREFIX)) {
      let p: string;
      try { p = decodeURIComponent(s.slice(PREFIX.length)); } catch { return; }
      const g = twinOf(p);
      if (g) idMap.set(s, PREFIX + encodeURIComponent(g));
      return;
    }
    if (s.startsWith("/")) {
      const g = twinOf(s);
      if (g) idMap.set(s, g);
    }
  };
  const visit = (o: unknown): void => {
    if (typeof o === "string") return collect(o);
    if (Array.isArray(o)) return o.forEach(visit);
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) { collect(k); visit(v); }
    }
  };
  visit(payload);
  if (idMap.size === 0) return payload;

  const rewrite = (o: unknown): unknown => {
    if (typeof o === "string") return idMap.get(o) ?? o;
    if (Array.isArray(o)) {
      const out = o.map(rewrite);
      // Dedup strings only: after the remap the same tab shows up twice.
      return out.every((x) => typeof x === "string") ? [...new Set(out as string[])] : out;
    }
    if (o && typeof o === "object") {
      const out: Record<string, unknown> = {};
      const entries = Object.entries(o);
      // TWO PASSES, and the order is the point: already-canonical keys first,
      // then the remapped ones only if the slot is still free. With a single pass
      // whoever came first in the object won, i.e. almost always the OLD pane —
      // and the content on screen was replaced by the dead one.
      for (const [k, v] of entries) if (!idMap.has(k)) out[k] = rewrite(v);
      for (const [k, v] of entries) {
        if (!idMap.has(k)) continue;
        const nk = idMap.get(k)!;
        if (nk in out) continue;
        out[nk] = rewrite(v);
      }
      return out;
    }
    return o;
  };
  return rewrite(payload);
}

export function stripDeviceLocalFields(payload: unknown, key?: string): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  // Shallow clone so we don't mutate caller data.
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };

  // `settings` (AppSettings): sidebar width and its collapsed state are geometry
  // OF THIS window, not user preferences — 256px on a 27" is half a screen on a
  // phone, and "collapsed" is forced on its own by detached windows and by
  // mobile. The client already strips them (`syncableSettings`); this is the same
  // defense-in-depth as the `scrollOffset` below: an old or bugged client must
  // not be able to impose its own geometry on every other device.
  if (key === SETTINGS_KEY) {
    for (const field of DEVICE_LOCAL_SETTINGS_FIELDS) delete out[field];
    return out;
  }

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
      `[ui-state/${ctx}] migration 012 not applied: payload_version column missing. Run \`bun run db:migrate\`.`,
    );
  }
  if (row.server_seq === undefined || row.server_seq === null) {
    throw new Error(
      `[ui-state/${ctx}] migration 012 not applied: server_seq column missing. Run \`bun run db:migrate\`.`,
    );
  }
}

export function createUiStateRouter(ctx: AppContext, opts?: UiStateRouterOptions): RouteHandler {
  const { db, json, broadcastToAll } = ctx;

  /**
   * A `project:` token this device may not turn into an allowlist root, or
   * null when the value is fine.
   *
   * `ui_state` is source 5 of `services/known-project-dirs.ts`: every
   * `project:` token in a stored value becomes one more directory the file
   * routes will hand out. The endpoint takes ARBITRARY JSON, so without this a
   * paired device writes `{"a":"project:/…/.ssh"}` under any key and reads
   * that directory back from `/api/files/content` on the next call.
   *
   * Only tokens that EXIST on disk are judged: `knownProjectDirs` realpaths
   * every entry and drops what is gone, so a pane still naming a project
   * directory that was deleted adds no root, and refusing that write would
   * jam a device's whole UI sync over a stale snapshot.
   */
  function refusedProjectToken(req: Request, serialized: string): string | null {
    for (const token of projectPathTokensIn(serialized)) {
      if (!existsSync(token)) continue;
      if (clientProjectPathRefused(req, token, ctx)) return token;
    }
    return null;
  }

  /** Il valore attuale di una chiave, gia' parsato. `null` = non c'era. */
  function readUiStateValue(key: string): unknown {
    const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(key) as { value: string } | null;
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  /** La cascata, isolata: un errore qui non deve mai far fallire un PUT — il
   *  pane store dell'utente e' piu' importante di una conseguenza in ritardo,
   *  che il riconcilio al boot recupera comunque. */
  function fireCascade(prev: unknown, next: unknown): void {
    if (!opts?.onPaneSnapshot) return;
    try { opts.onPaneSnapshot(prev, next); }
    catch (err) { console.error("[ui-state] cascata del ritiro fallita:", err); }
  }

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

      // Shape: QUALSIASI valore JSON, non solo un oggetto.
      //
      // Il vincolo "oggetto" arrivava dalla fase pane-state (`abbbbd05`), dove
      // ogni valore ERA un oggetto, ed è poi rimasto su un endpoint che è un
      // negozio generico chiave→JSON. Le due chiavi non-pane che ci passano —
      // `theme` (stringa) e `claude-prefs-skip` (booleano), entrambe scritte da
      // `useServerState<T>` — sono primitive: ogni loro PUT rispondeva 400 e il
      // valore NON veniva mai persistito. Il tema sopravviveva solo in
      // localStorage (quindi non seguiva l'utente su un altro dispositivo) e la
      // riga `claude-prefs-skip` nel DB era ferma a payload_version=1, cioè
      // all'ultima scrittura prima che il vincolo esistesse. In silenzio: il
      // hook fa `.catch(() => {})`, e un 400 in console non lo guarda nessuno.
      //
      // La lettura non ha mai avuto il problema (`GET` fa `JSON.parse` e
      // restituisce qualunque cosa), e `stripDeviceLocalFields` lascia passare
      // i non-oggetti intatti: era solo questa guardia a stare in mezzo. Un
      // `useServerState<number>` domani avrebbe ripetuto il guasto — la terza
      // volta.
      //
      // `null` resta fuori, ma per un motivo diverso: una chiave ASSENTE
      // risponde già `null` (riga 197), quindi un `null` scritto non è
      // rileggibile — sarebbe una scrittura che nessun lettore può distinguere
      // dal non aver mai scritto. Il PUT bulk qui sotto tiene invece il
      // vincolo oggetto: è il canale di pane-store/settings, dove è il contratto
      // vero, non un residuo.
      if (body === null) {
        return json({ error: "null is not a storable value (an absent key already reads as null)" }, 400);
      }

      // Defense-in-depth: strip device-local scrollOffset before persistence.
      const sanitized = dropVanishedProjectPanes(stripDeviceLocalFields(body, key), key);
      const value = JSON.stringify(sanitized);

      const refused = refusedProjectToken(req, value);
      if (refused) return json({ error: CLIENT_PROJECT_PATH_ERROR, path: refused }, 400);

      // Size cap: measured on the serialized-to-be-stored payload.
      if (value.length > MAX_UI_STATE_BYTES) {
        return json({ error: `Payload exceeds ${MAX_UI_STATE_BYTES} bytes`, limit: MAX_UI_STATE_BYTES, size: value.length }, 413);
      }

      // OPTIONAL compare-and-swap (`?base=<server_seq>`): "only write if the row
      // is still at the seq I last saw". Opt-in — a PUT without `base` behaves
      // exactly as before (test fixtures, server-internal writes, older clients).
      //
      // WHY: every PUT gets a FRESH, higher server_seq, and the client's HYDRATE
      // gate compares server_seq (reducers/panes.ts) — which orders WRITES, not
      // freshness. So a snapshot that is genuinely OLD still outranks everything
      // once written. A tab that slept through another device's changes and then
      // fires its teardown flush (`pagehide`/`visibilitychange`, syncServer.ts)
      // therefore REVERTS every other device to its stale state. `lastSeq` can't
      // arbitrate: it is a per-device dispatch counter, not a shared clock.
      // The base seq is the only value both sides agree on.
      const rawBase = _url.searchParams.get("base");
      const base = rawBase !== null && /^\d+$/.test(rawBase) ? Number(rawBase) : null;

      // Race-fix (Phase 30): use BEGIN IMMEDIATE instead of the default
      // BEGIN DEFERRED that bun:sqlite's db.transaction() emits. Two concurrent
      // PUT callers with DEFERRED can both execute the SELECT MAX before either
      // takes the write lock, see the same max, and collide on seq allocation.
      // IMMEDIATE acquires a RESERVED lock at BEGIN time, so a second writer
      // blocks until the first commits and then reads the updated MAX —
      // guaranteeing distinct, monotonically increasing server_seq values.
      // The CAS check lives INSIDE the same transaction, so the read of the
      // current seq and the write are atomic with respect to other writers.
      const outcome = db.transaction((): { written: boolean; server_seq: number; prev?: unknown } => {
        // Il PRIMA va letto DENTRO la transazione, o due PUT concorrenti
        // leggerebbero lo stesso «prima» e il secondo ricalcolerebbe una
        // cascata su uno stato che non esiste piu'.
        const prev = key === PANE_STORE_KEY && opts?.onPaneSnapshot ? readUiStateValue(key) : undefined;
        if (base !== null) {
          const cur = db.query(
            "SELECT server_seq FROM ui_state WHERE key = ?",
          ).get(key) as { server_seq: number } | null;
          // An absent row reads as seq 0, so a first write declares base=0.
          const curSeq = cur?.server_seq ?? 0;
          if (curSeq !== base) return { written: false, server_seq: curSeq };
        }
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
        return { written: true, server_seq: nextSeq, prev };
      }).immediate();

      if (!outcome.written) {
        // Someone else moved the row since `base`. Nothing was written and no
        // broadcast is emitted — the caller's snapshot was built on state that
        // is no longer current. `sendBeacon` can't read this response, which is
        // exactly the desired outcome: a dying tab's stale flush simply loses.
        return json({ error: "stale_base", server_seq: outcome.server_seq }, 409);
      }

      const server_seq = outcome.server_seq;
      if (key === PANE_STORE_KEY) fireCascade(outcome.prev, sanitized);
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
        const sanitized = stripDeviceLocalFields(v, k);
        const serialized = JSON.stringify(sanitized);
        if (serialized.length > MAX_UI_STATE_BYTES) {
          return json({ error: `Payload for key "${k}" exceeds ${MAX_UI_STATE_BYTES} bytes`, limit: MAX_UI_STATE_BYTES, size: serialized.length, key: k }, 413);
        }
        const refusedInBulk = refusedProjectToken(req, serialized);
        if (refusedInBulk) return json({ error: CLIENT_PROJECT_PATH_ERROR, path: refusedInBulk, key: k }, 400);
        totalSize += serialized.length;
        if (totalSize > MAX_UI_STATE_BYTES) {
          return json({ error: `Total bulk payload exceeds ${MAX_UI_STATE_BYTES} bytes`, limit: MAX_UI_STATE_BYTES, size: totalSize }, 413);
        }
        cleaned[k] = { sanitized, serialized };
      }

      // Race-fix (Phase 30): BEGIN IMMEDIATE — same rationale as the single-key
      // path above.
      const server_seqs: Record<string, number> = {};
      // Il pane store passa anche di qui: e' la strada del `sendBeacon` di
      // `pagehide`, cioe' proprio la chiusura di finestra in cui le conseguenze
      // lato client si perdono. Saltarla avrebbe lasciato scoperto il caso che
      // il guasto misurato produceva piu' spesso.
      let panePrev: unknown;
      const run = db.transaction(() => {
        if (PANE_STORE_KEY in cleaned && opts?.onPaneSnapshot) panePrev = readUiStateValue(PANE_STORE_KEY);
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
      if (PANE_STORE_KEY in cleaned) fireCascade(panePrev, cleaned[PANE_STORE_KEY].sanitized);

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

/**
 * I prefissi che l'`ui-state:init` NON porta — le chiavi per-task del browser.
 *
 * PERCHÉ. Lo snapshot va a OGNI client a OGNI riconnessione, e queste chiavi
 * crescono di una coppia per ogni task che apre un browser, per sempre (un task
 * non si cancella, si archivia — vedi `services/task-tab-teardown.ts`). Misura
 * sul db vivo dell'11/08: 91 righe `task-browser-*` su 172 di `ui_state`, 31 KB
 * su 101 KB — il 30,8% di uno snapshot che nessuno legge da lì.
 *
 * PERCHÉ SI PUÒ. Il client queste due chiavi le carica GIÀ da sé, con un GET
 * per-task (`ensureTaskTabsLoaded` / `ensureTaskLayoutLoaded`) quando apre quel
 * task: lo snapshot le portava solo perché la query non filtrava. Il layout non
 * ha nessun consumer di `ui-state:init`; le tab lo usavano come RESYNC di
 * riconnessione, e quel resync ora è mirato lato client — ri-GETta le sole
 * chiavi dei task che ha davvero in cache (`resyncTaskTabsFromServer`), di norma
 * zero o due invece di novanta.
 *
 * NON È UNA CANCELLAZIONE: le righe restano, il GET singolo le serve identiche.
 * `GET /api/ui-state` (all-keys) resta completo di proposito — è la porta di
 * servizio per chi vuole davvero tutto.
 */
export const UI_STATE_INIT_EXCLUDED_PREFIXES = ["task-browser-tabs:", "task-browser-layout:"] as const;

/** Vero se la chiave è esclusa dallo snapshot `ui-state:init` (gemello JS del WHERE sotto). */
export function isExcludedFromUiStateInit(key: string): boolean {
  return UI_STATE_INIT_EXCLUDED_PREFIXES.some((p) => key.startsWith(p));
}

// Nessun `_` o `%` nei prefissi ⇒ nessun escape da fare nel LIKE.
const INIT_EXCLUSION_WHERE = UI_STATE_INIT_EXCLUDED_PREFIXES.map(() => "key NOT LIKE ?").join(" AND ");
const INIT_EXCLUSION_PARAMS = UI_STATE_INIT_EXCLUDED_PREFIXES.map((p) => `${p}%`);

/** Helper to load all ui_state for WS init push — returns Option-A envelope { data, meta }.
 *  Le chiavi in `UI_STATE_INIT_EXCLUDED_PREFIXES` sono filtrate: il client le
 *  legge per-task, non da qui. */
export function loadAllUiState(db: import("bun:sqlite").Database): UiStateEnvelope {
  try {
    const rows = db.query(
      `SELECT key, value, payload_version, server_seq FROM ui_state WHERE ${INIT_EXCLUSION_WHERE}`,
    ).all(...INIT_EXCLUSION_PARAMS) as { key: string; value: string; payload_version: number; server_seq: number }[];
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
    throw new Error("[ui-state] boot check: ui_state table missing. Migrations did not run. Run `bun run db:migrate`.");
  }
  if (!/payload_version/i.test(tableRow.sql)) {
    throw new Error("[ui-state] boot check: migration 012 not applied: payload_version column missing. Run `bun run db:migrate`.");
  }
  if (!/server_seq/i.test(tableRow.sql)) {
    throw new Error("[ui-state] boot check: migration 012 not applied: server_seq column missing. Run `bun run db:migrate`.");
  }
}
