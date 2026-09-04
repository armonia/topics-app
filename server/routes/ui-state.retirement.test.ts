/**
 * La verifica del task, al seam dove vive davvero: chiudi una tab, riavvia il
 * server, riapri — niente ricompare, niente processo resta, e la stessa query
 * dice la stessa cosa dello schermo.
 *
 * Il «riavvio» qui è `reconcile` su un database che sopravvive: è esattamente
 * ciò che `server.ts` esegue all'avvio, e l'unico modo di provare che una
 * chiusura le cui conseguenze si erano perse viene onorata dopo, invece di
 * restare per un mese come le 11 sessioni misurate il 03/08.
 * @covers TAB-SYNC-01
 * @covers RETIRE-03
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { createUiStateRouter, PANE_STORE_KEY } from "./ui-state";
import { createOpenRouter } from "./open";
import { computeCascade } from "../services/pane-retirement-cascade";
import { applyPaneCascade, isRetired, listOpen, reconcile, retiredIds } from "../services/retirement";
import { isGlobalOrchestratorTopic } from "../services/global-orchestrator-session";
import type { AppContext } from "../types";

let db: Database;
let archived: string[];
let retiredTerminals: string[];
let router: ReturnType<typeof createUiStateRouter>;
let openRouter: ReturnType<typeof createOpenRouter>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Le conseguenze vere, ridotte al loro effetto sui registri. */
function consequences() {
  return {
    archiveTopic: (id: string) => { archived.push(id); db.run("UPDATE topics SET archived = 1 WHERE id = ?", [id]); },
    shouldRetireTopic: (id: string) => !isGlobalOrchestratorTopic(db, id),
    restoreTopic: (id: string) => { db.run("UPDATE topics SET archived = 0 WHERE id = ?", [id]); },
    retireTerminal: (id: string) => { retiredTerminals.push(id); db.run("DELETE FROM terminal_sessions WHERE id = ?", [id]); },
  };
}

function makeCtx(): AppContext {
  return { db, json, broadcastToAll: () => {} } as unknown as AppContext;
}

/** Il cablaggio di `server.ts`, identico. */
function onPaneSnapshot(prev: unknown, next: unknown) {
  const decision = computeCascade({ prev, next, alreadyRetired: retiredIds(db, "pane") });
  if (decision.retire.length === 0 && decision.reopen.length === 0) return;
  applyPaneCascade(db, consequences(), decision);
}

async function put(snapshot: unknown, base?: number) {
  const url = new URL(`http://x/api/ui-state/${PANE_STORE_KEY}${base === undefined ? "" : `?base=${base}`}`);
  const req = new Request(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) });
  const res = await router(req, url, url.pathname, "PUT");
  if (!res) throw new Error("il router non ha gestito il PUT");
  return { status: res.status, body: await res.json() };
}

async function getOpen() {
  const url = new URL("http://x/api/open");
  const res = await openRouter(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error("il router non ha gestito la GET");
  return res.json() as Promise<any>;
}

const snap = (o: Partial<{ panes: any; tombstones: any; closedStack: any[] }>) => ({
  panes: {}, tombstones: {}, closedStack: [], ...o,
});

beforeEach(() => {
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2, server_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`);
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    session_key TEXT NOT NULL UNIQUE, project_path TEXT, archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'shell', topic_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE global_orchestrator_sessions (
    scope TEXT PRIMARY KEY CHECK (scope = 'global'),
    topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(readFileSync(join(import.meta.dir, "..", "db", "migrations", "089-retirements.sql"), "utf-8"));
  db.run("INSERT INTO topics (id, name, slug, session_key, archived, created_at, updated_at) VALUES ('chat-1','Chat','c','sk1',0,'t','t')");
  db.run("INSERT INTO terminal_sessions (id, name, cwd, created_at) VALUES ('sess-1','bash','/w','t')");
  archived = [];
  retiredTerminals = [];
  router = createUiStateRouter(makeCtx(), { onPaneSnapshot });
  openRouter = createOpenRouter(makeCtx());
});

describe("prima di chiudere niente", () => {
  test("la query sola vede la chat e la sessione, e non ha divergenze", async () => {
    const open = await getOpen();
    expect(open.topics.map((t: any) => t.id)).toEqual(["chat-1"]);
    expect(open.terminals.map((t: any) => t.id)).toEqual(["sess-1"]);
    expect(open.divergences).toEqual([]);
  });
});

describe("chiudere una tab è il ritiro di ciò che contiene", () => {
  test("una chat: si archivia, e la query sola smette di vederla", async () => {
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    await put(snap({ tombstones: { "chat-1": { at: 1000, seq: 2 } } }));

    expect(archived).toEqual(["chat-1"]);
    const open = await getOpen();
    expect(open.topics).toEqual([]);
    expect(open.divergences).toEqual([]);
  });

  test("il coordinatore registrato sopravvive alla chiusura e riapertura della sua normale pane", async () => {
    db.run(
      `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
       VALUES ('global', 'chat-1', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`,
    );
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    await put(snap({ tombstones: { "chat-1": { at: 1000, seq: 2 } } }));

    expect(archived).toEqual([]);
    expect(isRetired(db, "topic", "chat-1")).toBe(false);
    expect((await getOpen()).topics.map((topic: any) => topic.id)).toEqual(["chat-1"]);

    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    expect(isRetired(db, "pane", "chat-1")).toBe(false);
    expect((await getOpen()).topics.map((topic: any) => topic.id)).toEqual(["chat-1"]);
  });

  test("un terminale: la sessione si ritira, e nessun processo resta", async () => {
    await put(snap({ panes: { "term-p": { id: "term-p", terminalSessionId: "sess-1" } } }));
    await put(snap({ tombstones: { "term-p": { at: 1000, seq: 2 } } }));

    expect(retiredTerminals).toEqual(["sess-1"]);
    const open = await getOpen();
    expect(open.terminals).toEqual([]);
    expect(open.divergences).toEqual([]);
  });

  test("il PUT ripetuto dello stesso snapshot non ri-uccide niente", async () => {
    const closed = snap({ tombstones: { "chat-1": { at: 1000, seq: 2 } } });
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    await put(closed);
    await put(closed);
    await put(closed);
    expect(archived).toEqual(["chat-1"]);
  });

  test("una scrittura rifiutata dal gate CAS non archivia niente", async () => {
    // Il 409 dice che quello snapshot il server l'ha scartato. Trarne le
    // conseguenze significherebbe archiviare una chat per uno stato che non è
    // mai stato scritto — e nessuna riapertura lo ritratterebbe.
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    const res = await put(snap({ tombstones: { "chat-1": { at: 1000, seq: 2 } } }), 99);

    expect(res.status).toBe(409);
    expect(archived).toEqual([]);
    expect(isRetired(db, "topic", "chat-1")).toBe(false);
  });

  test("assenza senza tombstone non chiude niente: l'idratazione è un'unione", async () => {
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    // Il telefono manda uno snapshot che non ha mai saputo di quella pane.
    await put(snap({ panes: {} }));

    expect(archived).toEqual([]);
    expect((await getOpen()).topics.map((t: any) => t.id)).toEqual(["chat-1"]);
  });
});

describe("riavvia il server, riapri il progetto", () => {
  test("una chiusura le cui conseguenze si erano perse viene onorata al riavvio", async () => {
    // Lo stato del 03/08: il fatto sa della chiusura, i registri no — la
    // `keepalive` è morta col `pagehide`, o la tab è stata chiusa altrove.
    db.run("INSERT INTO retirements (kind, ref_id, retired_at, reason) VALUES ('topic','chat-1','2026-07-20','tab-close')");
    db.run("INSERT INTO retirements (kind, ref_id, retired_at, reason) VALUES ('terminal','sess-1','2026-07-20','tab-close')");
    expect((await getOpen()).divergences).toHaveLength(2);

    reconcile(db, consequences());

    expect(archived).toEqual(["chat-1"]);
    expect(retiredTerminals).toEqual(["sess-1"]);
    const open = await getOpen();
    expect(open.topics).toEqual([]);
    expect(open.terminals).toEqual([]);
    expect(open.divergences).toEqual([]);
  });

  test("il riconcilio non riapre una chat che l'utente aveva archiviato", async () => {
    db.run("UPDATE topics SET archived = 1 WHERE id = 'chat-1'");

    reconcile(db, consequences());

    expect(db.query("SELECT archived FROM topics WHERE id = 'chat-1'").get()).toEqual({ archived: 1 });
    expect(isRetired(db, "topic", "chat-1")).toBe(true);
    expect((await getOpen()).divergences).toEqual([]);
  });

  test("il riconcilio ritratta un vecchio ritiro del coordinatore invece di archiviarlo", async () => {
    db.run(
      `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
       VALUES ('global', 'chat-1', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`,
    );
    db.run("INSERT INTO retirements (kind, ref_id, retired_at, reason) VALUES ('topic','chat-1','2026-07-20','tab-close')");

    reconcile(db, consequences());

    expect(archived).toEqual([]);
    expect(isRetired(db, "topic", "chat-1")).toBe(false);
    expect((await getOpen()).topics.map((topic: any) => topic.id)).toEqual(["chat-1"]);
  });

  test("chiudi, riavvia, e la query concorda ancora con lo schermo", async () => {
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" }, "term-p": { id: "term-p", terminalSessionId: "sess-1" } } }));
    await put(snap({ tombstones: { "chat-1": { at: 1, seq: 2 }, "term-p": { at: 1, seq: 2 } } }));

    const res = reconcile(db, consequences());

    expect(res.examined).toBe(0); // non c'era piu' niente da riparare
    const open = await getOpen();
    expect(open.counts).toEqual({ topics: 0, terminals: 0, divergences: 0 });
  });
});

describe("la riapertura", () => {
  test("annullare la chiusura ritratta il fatto, e la chiusura successiva torna a valere", async () => {
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    await put(snap({ tombstones: { "chat-1": { at: 1, seq: 2 } } }));
    expect(isRetired(db, "pane", "chat-1")).toBe(true);

    // ⇧⌘T: la pane torna, il marcatore sparisce.
    db.run("UPDATE topics SET archived = 0 WHERE id = 'chat-1'");
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    expect(isRetired(db, "pane", "chat-1")).toBe(false);

    await put(snap({ tombstones: { "chat-1": { at: 9, seq: 5 } } }));
    expect(archived).toEqual(["chat-1", "chat-1"]);
  });

  test("il riavvio dopo una riapertura NON richiude la chat con l'utente dentro", async () => {
    // Il buco: ritrattare solo la PANE lasciava il topic timbrato «ritirato»
    // mentre la sua chat era di nuovo sullo schermo — e il riconcilio al boot
    // successivo la archiviava.
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    await put(snap({ tombstones: { "chat-1": { at: 1, seq: 2 } } }));

    db.run("UPDATE topics SET archived = 0 WHERE id = 'chat-1'");
    await put(snap({ panes: { "chat-1": { id: "chat-1", topicId: "chat-1" } } }));
    archived = [];

    reconcile(db, consequences());

    expect(archived).toEqual([]);
    expect((await getOpen()).topics.map((t: any) => t.id)).toEqual(["chat-1"]);
  });
});

describe("GET /api/open è sola lettura", () => {
  test("interrogare non ripara: la diagnosi non cambia ciò che diagnostica", async () => {
    db.run("INSERT INTO retirements (kind, ref_id, retired_at) VALUES ('topic','chat-1','2026-07-20')");

    const first = await getOpen();
    const second = await getOpen();

    expect(first.divergences).toHaveLength(1);
    expect(second.divergences).toHaveLength(1);
    expect(archived).toEqual([]);
    expect(listOpen(db).divergences).toHaveLength(1);
  });
});
