/**
 * The server side of the pane store (`/api/ui-state`): every write stamps
 * `payload_version` and a monotonic, gap-free `server_seq` even under concurrent
 * PUTs, the all-keys read keeps the legacy shape beside the new envelope, and the
 * endpoint validates its body (null refused, oversize capped).
 *
 * @covers LAYOUT-01
 */
import { test, expect } from "./fixtures/test-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { openSocket } from "./helpers/node-websocket";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

test.describe("PANE server migration (012): payload_version + server_seq", () => {
  test("PUT /api/ui-state/:key stamps payload_version=2 and increments server_seq", async ({ request }) => {
    const key = `pane-store-v2-test-${Date.now()}`;

    // First write
    const putA = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
      data: { hello: "world", seq: 1 },
    });
    expect(putA.ok()).toBe(true);

    const getA = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(key)}`);
    expect(getA.ok()).toBe(true);
    const bodyA = await getA.json();
    expect(bodyA.value).toMatchObject({ hello: "world", seq: 1 });
    expect(bodyA.payload_version).toBe(2);
    expect(typeof bodyA.server_seq).toBe("number");
    expect(bodyA.server_seq).toBeGreaterThan(0);

    // Second write bumps server_seq
    const putB = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
      data: { hello: "world", seq: 2 },
    });
    expect(putB.ok()).toBe(true);

    const getB = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(key)}`);
    const bodyB = await getB.json();
    expect(bodyB.payload_version).toBe(2);
    expect(bodyB.server_seq).toBeGreaterThan(bodyA.server_seq);
  });

  test("server_seq is monotonic across writes to different keys", async ({ request }) => {
    const k1 = `pane-a-${Date.now()}`;
    const k2 = `pane-b-${Date.now()}`;

    const p1 = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(k1)}`, { data: { x: 1 } });
    expect(p1.ok()).toBe(true);
    const p2 = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(k2)}`, { data: { x: 2 } });
    expect(p2.ok()).toBe(true);

    const r1 = await (await request.get(`${BASE}/api/ui-state/${encodeURIComponent(k1)}`)).json();
    const r2 = await (await request.get(`${BASE}/api/ui-state/${encodeURIComponent(k2)}`)).json();

    expect(r2.server_seq).toBeGreaterThan(r1.server_seq);
  });

  test("GET /api/ui-state (all-keys) returns Option-A parallel envelope: { data, meta } with legacy data[key] shape", async ({ request }) => {
    const key = `pane-init-test-${Date.now()}`;
    const seedValue = { initial: true, shape: "legacy" };
    await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, { data: seedValue });

    const resp = await request.get(`${BASE}/api/ui-state`);
    expect(resp.ok()).toBe(true);
    const all = await resp.json();

    // Envelope shape: { data, meta }
    expect(all).toHaveProperty("data");
    expect(all).toHaveProperty("meta");

    // data[key] is the RAW parsed value (legacy shape — backward compatible)
    expect(all.data[key]).toEqual(seedValue);
    expect(all.data[key]).not.toHaveProperty("payload_version");
    expect(all.data[key]).not.toHaveProperty("server_seq");

    // meta[key] carries the version metadata
    expect(all.meta[key]).toBeDefined();
    expect(all.meta[key].payload_version).toBe(2);
    expect(typeof all.meta[key].server_seq).toBe("number");
    expect(all.meta[key].server_seq).toBeGreaterThan(0);
  });

  test("GET /api/ui-state all-keys: a pre-migration v1 row shows payload_version=1 in meta while data preserves the raw value", async ({ request }) => {
    // This test does not need to synthesize a v1 row explicitly — migration 012's
    // DEFAULT 1 applies to any row that existed before the migration. We assert
    // the invariant: every key in data has a corresponding meta entry with a
    // numeric payload_version (either 1 from pre-migration or 2 from a subsequent write).
    const resp = await request.get(`${BASE}/api/ui-state`);
    expect(resp.ok()).toBe(true);
    const all = await resp.json();
    for (const k of Object.keys(all.data)) {
      expect(all.meta).toHaveProperty(k);
      expect(typeof all.meta[k].payload_version).toBe("number");
      expect([1, 2]).toContain(all.meta[k].payload_version);
    }
  });
});

test.describe("PANE server migration (012): concurrent PUTs allocate unique, monotonic server_seq", () => {
  // These tests prove the race-condition fix in server/routes/ui-state.ts
  // (BEGIN IMMEDIATE on the PUT transactions). Without the fix, two concurrent
  // writers on a DEFERRED txn can both SELECT MAX(server_seq), see the same
  // value, and collide on allocation — producing duplicate seqs or gaps.
  //
  // N=24 matches the guarantee quoted in the PR body ("Verified via 24-PUT-
  // parallel tests, distinct keys + same key"). Each PUT is serialized by
  // BEGIN IMMEDIATE on SQLite, so 24 concurrent writers serialize to ~24
  // sequential txns; on a cold CI runner this can exceed Playwright's
  // default per-test timeout. `test.slow()` triples the budget (Playwright
  // docs) which keeps the timing-sensitive assertions stable without
  // weakening them.
  const N = 24; // matches PR body claim; > 10 concurrent writers

  test("N concurrent PUTs to DIFFERENT keys each get a unique, gap-free server_seq", async ({ request }) => {
    // SQLite serializes PUTs under BEGIN IMMEDIATE; timing-sensitive on cold CI.
    test.slow();

    // Unique run id so the test is independent of any other rows already in ui_state.
    const runId = `concurrent-distinct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keys = Array.from({ length: N }, (_, i) => `${runId}-k${i}`);

    // Fire all PUTs simultaneously. Promise.all spawns all requests before
    // awaiting any, so on the server side they race into the txn together.
    const responses = await Promise.all(
      keys.map((k, i) =>
        request.put(`${BASE}/api/ui-state/${encodeURIComponent(k)}`, {
          data: { idx: i, runId },
        }),
      ),
    );

    // All must succeed.
    for (const r of responses) expect(r.ok()).toBe(true);

    const bodies = await Promise.all(responses.map((r) => r.json()));
    const seqs = bodies.map((b) => b.server_seq as number);

    // 1. Every seq is a positive number.
    for (const s of seqs) {
      expect(typeof s).toBe("number");
      expect(s).toBeGreaterThan(0);
    }

    // 2. All N seqs are UNIQUE (no duplicates — the exact failure mode of the
    //    race on the pre-fix code).
    const unique = new Set(seqs);
    expect(unique.size).toBe(N);

    // 3. The N allocated seqs form a dense, contiguous increasing set:
    //    max - min + 1 === N  (no gaps, no duplicates). This is strictly
    //    stronger than "unique" and catches partial overlap regressions too.
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1] - sorted[0] + 1).toBe(N);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1);
    }
  });

  test("N concurrent PUTs to the SAME key — final stored server_seq equals MAX of allocated seqs (LWW holds)", async ({ request }) => {
    // SQLite serializes PUTs under BEGIN IMMEDIATE; timing-sensitive on cold CI.
    test.slow();
    const key = `concurrent-same-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
          data: { writer: i },
        }),
      ),
    );

    for (const r of responses) expect(r.ok()).toBe(true);

    const bodies = await Promise.all(responses.map((r) => r.json()));
    const seqs = bodies.map((b) => b.server_seq as number);

    // Same key — still, each write must have received a distinct seq
    // (each PUT allocates its own MAX+1 under IMMEDIATE serialization).
    expect(new Set(seqs).size).toBe(N);
    const maxAllocated = Math.max(...seqs);

    // The final stored row's server_seq must equal the highest allocated seq,
    // i.e. last-write-wins survives the race.
    const get = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(key)}`);
    expect(get.ok()).toBe(true);
    const stored = await get.json();
    expect(stored.server_seq).toBe(maxAllocated);
    expect(stored.payload_version).toBe(2);
  });
});

test.describe("ui-state hardening (Bug #6, #7): validation + size cap + device-local strip", () => {
  // Matches MAX_UI_STATE_BYTES in server/routes/ui-state.ts
  const MAX_BYTES = 256 * 1024;

  // Il vincolo "il valore dev'essere un oggetto" sul PUT a chiave singola è
  // stato TOLTO, e non per allentare l'hardening: quell'endpoint è un negozio
  // generico chiave→JSON, e la guardia — ereditata dalla fase pane-state, dove
  // ogni valore ERA un oggetto — rifiutava con 400 le uniche due chiavi non-pane
  // che ci passano, `theme` (stringa) e `claude-prefs-skip` (booleano), scritte
  // da useServerState<T> che manda il valore nudo. Il tema non è MAI stato
  // persistito lato server, e in silenzio (il hook fa `.catch(() => {})`).
  // Il cap di dimensione, lo strip dei campi device-local e il vincolo oggetto
  // sul PUT BULK — che è il canale di pane-store/settings, dove è il contratto
  // vero — restano tutti. Vedi server/routes/ui-state.scalar.test.ts.
  test("PUT /api/ui-state/:key accepts an array body (generic key→JSON store)", async ({ request }) => {
    const key = `harden-array-${Date.now()}`;
    const resp = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
      data: [1, 2, 3],
    });
    expect(resp.status()).toBe(200);
    const get = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(key)}`);
    expect((await get.json()).value).toEqual([1, 2, 3]);
  });

  test("PUT /api/ui-state/:key accepts a primitive body (the `theme` case)", async ({ request }) => {
    const key = `harden-str-${Date.now()}`;
    // `data: "..."` da solo verrebbe spedito come text/plain con il corpo NUDO,
    // che non è JSON valido: il 400 arriverebbe dal parser, non dalla regola in
    // esame, e il test passerebbe per il motivo sbagliato. Si spedisce la
    // stringa JSON-encoded, esattamente come fa useServerState.
    const resp = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify("dark"),
    });
    expect(resp.status()).toBe(200);
    const get = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(key)}`);
    expect((await get.json()).value).toBe("dark");
  });

  test("PUT /api/ui-state/:key rejects a null body with 400", async ({ request }) => {
    // Unico valore JSON che resta fuori, e per una ragione diversa: una chiave
    // ASSENTE risponde già `null`, quindi un null scritto non è rileggibile.
    const key = `harden-null-${Date.now()}`;
    const resp = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
      headers: { "Content-Type": "application/json" },
      data: "null",
    });
    expect(resp.status()).toBe(400);
  });

  test("PUT /api/ui-state/:key rejects oversize body with 413", async ({ request }) => {
    const key = `harden-size-${Date.now()}`;
    // 260 KB of 'x' — exceeds the 256 KB cap by ~4 KB
    const big = { blob: "x".repeat(260 * 1024) };
    const resp = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
      data: big,
    });
    expect(resp.status()).toBe(413);
    const body = await resp.json();
    expect(body.limit).toBe(MAX_BYTES);
  });

  test("PUT /api/ui-state (bulk) rejects non-object root with 400", async ({ request }) => {
    const resp = await request.put(`${BASE}/api/ui-state`, {
      data: ["not", "an", "object"],
    });
    expect(resp.status()).toBe(400);
  });

  test("PUT /api/ui-state (bulk) rejects non-object value with 400", async ({ request }) => {
    const resp = await request.put(`${BASE}/api/ui-state`, {
      data: { [`harden-bulk-${Date.now()}`]: "not an object" },
    });
    expect(resp.status()).toBe(400);
  });

  test("PUT /api/ui-state (bulk) rejects per-key oversize with 413", async ({ request }) => {
    const key = `harden-bulk-size-${Date.now()}`;
    const resp = await request.put(`${BASE}/api/ui-state`, {
      data: { [key]: { blob: "x".repeat(260 * 1024) } },
    });
    expect(resp.status()).toBe(413);
  });

  test("PUT /api/ui-state/:key strips device-local scrollOffset recursively (defense-in-depth)", async ({ request }) => {
    const key = `harden-strip-${Date.now()}`;
    const payload = {
      panes: {
        p1: { id: "p1", type: "chat", title: "t", scrollOffset: 42 },
      },
      projects: {
        "/proj": {
          projectPath: "/proj",
          panes: {
            p2: { id: "p2", type: "file", title: "t2", scrollOffset: 99 },
          },
        },
      },
      closedStack: [
        { id: "c1", pane: { id: "p3", type: "chat", title: "t3", scrollOffset: 7 }, scrollOffset: 11 },
      ],
    };
    const put = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, { data: payload });
    expect(put.ok()).toBe(true);

    const get = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(key)}`);
    const body = await get.json();
    const stored = body.value;

    // scrollOffset stripped from all three known nested locations
    expect(stored.panes.p1.scrollOffset).toBeUndefined();
    expect(stored.projects["/proj"].panes.p2.scrollOffset).toBeUndefined();
    expect(stored.closedStack[0].pane.scrollOffset).toBeUndefined();

    // Outer closedStack[].scrollOffset is INTENTIONALLY retained (PANE-03 undo fidelity)
    expect(stored.closedStack[0].scrollOffset).toBe(11);
    // Other fields survive
    expect(stored.panes.p1.title).toBe("t");
    expect(stored.projects["/proj"].panes.p2.title).toBe("t2");
  });
});

test.describe("PANE server migration (012): broadcast shape & sourceClientId (findings #10/#11)", () => {
  // These tests prove the broadcast contract: single PUT emits `ui-state:updated`,
  // bulk PUT emits `ui-state:patch` with only the written keys (NOT a full
  // `ui-state:init`), and every broadcast carries `sourceClientId` matching the
  // `X-Client-Id` header the caller sent. The patch shape is the fix for the
  // bulk fan-out target declared in performance/spec.md.

  /**
   * Connect to the server's /ws endpoint and collect frames matching `predicate`
   * until `stop()` is called (or timeout fires). Returns the collected frames.
   */
  async function collectFrames(
    predicate: (msg: any) => boolean,
    action: () => Promise<void>,
    opts: { timeoutMs?: number } = {},
  ): Promise<any[]> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    // `BASE` is http://…; the WS endpoint is ws://…/ws (same host/port).
    const wsUrl = BASE.replace(/^http/, "ws") + "/ws";
    const ws = openSocket(wsUrl);
    const frames: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(to); resolve(); });
      ws.addEventListener("error", (e: any) => { clearTimeout(to); reject(e); });
    });
    ws.addEventListener("message", (e: any) => {
      try {
        const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
        if (predicate(msg)) frames.push(msg);
      } catch { /* ignore non-JSON frames */ }
    });
    // Drain any immediate `ui-state:init` the server pushes on open.
    await new Promise((r) => setTimeout(r, 200));
    // Clear any pre-existing frames from the open init push — we only want
    // frames produced by `action()`.
    frames.length = 0;
    try {
      await action();
      // Allow the broadcast to round-trip.
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      ws.close();
    }
    return frames;
  }

  test("single PUT broadcast carries sourceClientId matching X-Client-Id header (finding #10)", async ({ request }) => {
    const key = `src-cid-single-${Date.now()}`;
    const cid = `test-tab-${Math.random().toString(36).slice(2, 10)}`;

    const frames = await collectFrames(
      (m) => m && m.type === "ui-state:updated" && m.key === key,
      async () => {
        const put = await request.put(`${BASE}/api/ui-state/${encodeURIComponent(key)}`, {
          data: { hello: "cid" },
          headers: { "X-Client-Id": cid },
        });
        expect(put.ok()).toBe(true);
      },
    );

    expect(frames.length).toBeGreaterThanOrEqual(1);
    const frame = frames[0];
    expect(frame.type).toBe("ui-state:updated");
    expect(frame.key).toBe(key);
    expect(frame.sourceClientId).toBe(cid);
    expect(typeof frame.server_seq).toBe("number");
    expect(frame.payload_version).toBe(2);
  });

  test("bulk PUT broadcasts ui-state:patch with only the written keys — not a full ui-state:init (finding #11)", async ({ request }) => {
    const runId = `patch-delta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cid = `test-bulk-${Math.random().toString(36).slice(2, 10)}`;
    const k1 = `${runId}-a`;
    const k2 = `${runId}-b`;
    const k3 = `${runId}-c`;
    const payload = {
      [k1]: { a: 1 },
      [k2]: { b: 2 },
      [k3]: { c: 3 },
    };

    const frames = await collectFrames(
      (m) => m && (m.type === "ui-state:patch" || m.type === "ui-state:init"),
      async () => {
        const res = await request.put(`${BASE}/api/ui-state`, {
          data: payload,
          headers: { "X-Client-Id": cid },
        });
        expect(res.ok()).toBe(true);
      },
    );

    // Exactly one patch frame, and NO ui-state:init for bulk writes.
    const patchFrames = frames.filter((f) => f.type === "ui-state:patch");
    const initFrames = frames.filter((f) => f.type === "ui-state:init");
    expect(patchFrames.length).toBe(1);
    expect(initFrames.length).toBe(0);

    const patch = patchFrames[0];
    expect(patch.sourceClientId).toBe(cid);
    expect(typeof patch.entries).toBe("object");
    expect(patch.entries).not.toBeNull();

    // Must contain EXACTLY the 3 keys this request wrote — not the whole
    // ui_state table. That's the fan-out fix.
    const entryKeys = Object.keys(patch.entries).sort();
    expect(entryKeys).toEqual([k1, k2, k3].sort());

    for (const k of [k1, k2, k3]) {
      expect(patch.entries[k].payload_version).toBe(2);
      expect(typeof patch.entries[k].server_seq).toBe("number");
      expect(patch.entries[k].server_seq).toBeGreaterThan(0);
      expect(patch.entries[k].data).toEqual(payload[k]);
    }
  });

  test("bulk PUT via ?cid= query param also round-trips sourceClientId (beacon path, finding #10)", async ({ request }) => {
    // sendBeacon can't set custom headers, so the client falls back to a
    // ?cid= query param. Server must accept either channel.
    const runId = `patch-cid-query-${Date.now()}`;
    const cid = `beacon-tab-${Math.random().toString(36).slice(2, 10)}`;
    const k = `${runId}-only`;

    const frames = await collectFrames(
      (m) => m && m.type === "ui-state:patch",
      async () => {
        const res = await request.put(`${BASE}/api/ui-state?cid=${encodeURIComponent(cid)}`, {
          data: { [k]: { via: "beacon" } },
        });
        expect(res.ok()).toBe(true);
      },
    );

    expect(frames.length).toBe(1);
    expect(frames[0].sourceClientId).toBe(cid);
  });
});

test.describe("PANE server migration (012): bulk PUT returns server_seqs map", () => {
  test("PUT /api/ui-state (bulk) returns server_seqs with dense, unique, monotonic seqs per key", async ({ request }) => {
    const runId = `bulk-seqs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload: Record<string, unknown> = {
      [`${runId}-k1`]: { a: 1 },
      [`${runId}-k2`]: { b: 2 },
      [`${runId}-k3`]: { c: 3 },
    };
    const keys = Object.keys(payload);

    const res = await request.put(`${BASE}/api/ui-state`, { data: payload });
    expect(res.ok()).toBe(true);
    const body = await res.json();

    // Response must include ok and server_seqs map
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("server_seqs");
    expect(typeof body.server_seqs).toBe("object");

    // Every key must have a numeric seq
    for (const k of keys) {
      expect(body.server_seqs).toHaveProperty(k);
      expect(typeof body.server_seqs[k]).toBe("number");
      expect(body.server_seqs[k]).toBeGreaterThan(0);
    }

    // Seqs must be unique
    const seqs = keys.map((k) => body.server_seqs[k] as number);
    expect(new Set(seqs).size).toBe(keys.length);

    // Seqs must be dense (contiguous) and monotonically increasing in insertion order
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1] - sorted[0] + 1).toBe(keys.length);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1);
    }

    // Verify stored values match via GET
    for (const k of keys) {
      const get = await request.get(`${BASE}/api/ui-state/${encodeURIComponent(k)}`);
      expect(get.ok()).toBe(true);
      const stored = await get.json();
      expect(stored.server_seq).toBe(body.server_seqs[k]);
      expect(stored.payload_version).toBe(2);
    }
  });
});
