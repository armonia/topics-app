/**
 * La route di reset svuota OGNI tabella. L'unica cosa che le impedisce di
 * esistere sul server vero è il gate su `TOPICS_E2E`, quindi il gate è la cosa
 * da testare: se cede, cede in un posto dove non c'è nessuna suite a
 * accorgersene.
  * @covers E2E-GATE-03
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { baselinePath, createE2eRouter, e2eRoutesEnabled } from "./e2e";
import type { AppContext } from "../types";

function ctxWith(db: Database): AppContext {
  return {
    db,
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  } as unknown as AppContext;
}

function testDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.run("CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, server_seq INTEGER NOT NULL DEFAULT 0)");
  return db;
}

const call = (router: ReturnType<typeof createE2eRouter>, path: string, method = "POST") =>
  router(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`), path, method);

let dataDir = "";
let prevFlag: string | undefined;
let prevData: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "e2e-route-"));
  prevFlag = process.env.TOPICS_E2E;
  prevData = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevFlag === undefined) delete process.env.TOPICS_E2E; else process.env.TOPICS_E2E = prevFlag;
  if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("gate", () => {
  it("è armato solo da TOPICS_E2E=1", () => {
    expect(e2eRoutesEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(e2eRoutesEnabled({ TOPICS_E2E: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(e2eRoutesEnabled({ TOPICS_E2E: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(e2eRoutesEnabled({ TOPICS_E2E: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("senza il flag le route non esistono affatto (404, non 403 disarmato)", async () => {
    delete process.env.TOPICS_E2E;
    const router = createE2eRouter(ctxWith(testDb()));
    expect(await call(router, "/api/test/checkpoint")).toBeNull();
    expect(await call(router, "/api/test/reset")).toBeNull();
  });

  it("la baseline vive sotto DATA_DIR, cioè per-shard", () => {
    expect(baselinePath({ DATA_DIR: "/tmp/x" } as unknown as NodeJS.ProcessEnv)).toBe("/tmp/x/e2e-baseline.json");
  });
});

describe("checkpoint + reset", () => {
  it("riporta il DB alla fotografia e scrive la baseline su disco", async () => {
    process.env.TOPICS_E2E = "1";
    const db = testDb();
    db.run("INSERT INTO topics (id, name) VALUES ('t1', 'baseline')");
    const router = createE2eRouter(ctxWith(db));

    const cp = await call(router, "/api/test/checkpoint");
    expect(cp?.status).toBe(200);
    expect(existsSync(join(dataDir, "e2e-baseline.json"))).toBe(true);

    db.run("INSERT INTO topics (id, name) VALUES ('t2', 'sporca')");
    const res = await call(router, "/api/test/reset");
    expect(res?.status).toBe(200);
    expect(db.query("SELECT id FROM topics").all()).toEqual([{ id: "t1" }]);
  });

  it("i server_seq ripristinati salgono SOPRA il massimo corrente", async () => {
    // Altrimenti tornerebbero indietro e il client, che fa LWW su quel numero,
    // scarterebbe l'hydrate del reset restando col workspace del file prima.
    process.env.TOPICS_E2E = "1";
    const db = testDb();
    db.run("INSERT INTO ui_state (key, value, server_seq) VALUES ('panels', '{}', 2)");
    const router = createE2eRouter(ctxWith(db));
    await call(router, "/api/test/checkpoint");

    db.run("UPDATE ui_state SET server_seq = 57");
    await call(router, "/api/test/reset");
    expect((db.query("SELECT server_seq AS s FROM ui_state").get() as { s: number }).s).toBe(59);
  });

  it("un reset senza fotografia risponde 409 invece di fingere di aver ripulito", async () => {
    process.env.TOPICS_E2E = "1";
    const router = createE2eRouter(ctxWith(testDb()));
    const res = await call(router, "/api/test/reset");
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ error: "no_checkpoint" });
  });

  it("la fotografia sopravvive al riavvio del server (una spec lo riavvia a metà run)", async () => {
    process.env.TOPICS_E2E = "1";
    const db = testDb();
    db.run("INSERT INTO topics (id, name) VALUES ('t1', 'baseline')");
    await call(createE2eRouter(ctxWith(db)), "/api/test/checkpoint");

    // Router nuovo = processo nuovo: nessuna cache calda, solo il file.
    const afterRestart = createE2eRouter(ctxWith(db));
    db.run("INSERT INTO topics (id, name) VALUES ('t2', 'sporca')");
    expect((await call(afterRestart, "/api/test/reset"))?.status).toBe(200);
    expect(db.query("SELECT id FROM topics").all()).toEqual([{ id: "t1" }]);
  });
});
