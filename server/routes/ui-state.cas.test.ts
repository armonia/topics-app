/**
 * Compare-and-swap gate on PUT /api/ui-state/:key (`?base=<server_seq>`).
 *
 * The bug it closes: every PUT gets a FRESH, higher `server_seq`, and the
 * client's HYDRATE gate compares `server_seq` — which orders WRITES, not
 * freshness. So a genuinely OLD snapshot still outranks everything once
 * written. A tab that slept through another device's changes and then fires
 * its teardown flush (`pagehide` / `visibilitychange`, client syncServer.ts)
 * therefore reverts every other device to its stale state.
 *
 * The gate is OPT-IN: a PUT without `base` behaves exactly as before, so test
 * fixtures, server-internal writes and older clients are untouched.
 * @covers LAYOUT-02
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createUiStateRouter } from "./ui-state";
import type { AppContext } from "../types";

const KEY = "pane-store-v2";

let db: Database;
let broadcasts: any[];
let router: ReturnType<typeof createUiStateRouter>;

function makeCtx(): AppContext {
  return {
    db,
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    broadcastToAll: (msg: unknown) => { broadcasts.push(msg); },
  } as unknown as AppContext;
}

/** PUT `snapshot` to the router, optionally declaring a CAS base seq. */
async function put(
  snapshot: unknown,
  base?: number,
): Promise<{ status: number; body: any }> {
  const qs = base === undefined ? "" : `?base=${base}`;
  const url = new URL(`http://x/api/ui-state/${KEY}${qs}`);
  const req = new Request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  const res = await router(req, url, url.pathname, "PUT");
  if (!res) throw new Error("router did not handle the PUT");
  return { status: res.status, body: await res.json() };
}

function storedValue(): any {
  const row = db.query("SELECT value FROM ui_state WHERE key = ?").get(KEY) as
    | { value: string }
    | null;
  return row ? JSON.parse(row.value) : null;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2,
    server_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  broadcasts = [];
  router = createUiStateRouter(makeCtx());
});

describe("PUT /api/ui-state/:key — CAS gate", () => {
  test("without ?base the write always lands (unchanged legacy behaviour)", async () => {
    const first = await put({ panes: { a: 1 } });
    expect(first.status).toBe(200);
    const second = await put({ panes: { b: 2 } });
    expect(second.status).toBe(200);
    expect(second.body.server_seq).toBeGreaterThan(first.body.server_seq);
    expect(storedValue()).toEqual({ panes: { b: 2 } });
  });

  test("?base=0 is the correct base for a row that does not exist yet", async () => {
    const res = await put({ panes: { a: 1 } }, 0);
    expect(res.status).toBe(200);
    expect(storedValue()).toEqual({ panes: { a: 1 } });
  });

  test("a matching base is accepted and advances server_seq", async () => {
    const first = await put({ panes: { a: 1 } });
    const second = await put({ panes: { b: 2 } }, first.body.server_seq);
    expect(second.status).toBe(200);
    expect(second.body.server_seq).toBe(first.body.server_seq + 1);
    expect(storedValue()).toEqual({ panes: { b: 2 } });
  });

  test("a STALE base is refused: 409, nothing written, nothing broadcast", async () => {
    // Device A writes; the row moves to seq N.
    const a = await put({ panes: { fresh: true } });
    const staleBase = a.body.server_seq - 1; // what a sleeping tab still believes
    broadcasts = [];

    const b = await put({ panes: { stale: true } }, staleBase);

    expect(b.status).toBe(409);
    expect(b.body.error).toBe("stale_base");
    // The response tells the caller where the row actually is.
    expect(b.body.server_seq).toBe(a.body.server_seq);
    // The whole point: the fresh snapshot survives, and no other device is told
    // to hydrate anything.
    expect(storedValue()).toEqual({ panes: { fresh: true } });
    expect(broadcasts).toHaveLength(0);
  });

  test("a refused write does not consume a server_seq", async () => {
    const a = await put({ panes: { fresh: true } });
    await put({ panes: { stale: true } }, 0);
    // Next legitimate write is seq+1, not seq+2 — the conflict allocated nothing.
    const c = await put({ panes: { newer: true } }, a.body.server_seq);
    expect(c.body.server_seq).toBe(a.body.server_seq + 1);
  });

  test("a non-numeric base is ignored rather than rejecting the write", async () => {
    // Defensive: a malformed query param must not brick sync.
    const url = new URL(`http://x/api/ui-state/${KEY}?base=NaN`);
    const req = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ panes: { a: 1 } }),
    });
    const res = await router(req, url, url.pathname, "PUT");
    expect(res!.status).toBe(200);
  });

  test("the gate is per-key: a sibling key moving does not block us", async () => {
    const mine = await put({ panes: { a: 1 } });
    // Another key advances the GLOBAL max seq...
    const otherUrl = new URL("http://x/api/ui-state/panels");
    await router(
      new Request(otherUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openPanels: ["x"] }),
      }),
      otherUrl,
      otherUrl.pathname,
      "PUT",
    );
    // ...but OUR row hasn't moved, so our base is still valid.
    const res = await put({ panes: { b: 2 } }, mine.body.server_seq);
    expect(res.status).toBe(200);
  });
});
