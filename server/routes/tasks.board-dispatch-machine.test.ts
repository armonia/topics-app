/**
 * The board's default execution machine: the rule for WHICH cards go to the
 * paired PC node. Runs on the REAL schema (the embedded migration chain), so
 * the new column, the FK to `machines` and the whole create path are the ones
 * that ship.
 *
 * What it guards: a card created on a board with `dispatchMachineId` is born
 * pointing at that machine (unless the request says otherwise), and the setting
 * itself cannot be written for a machine that would park every card forever.
 *
 * @covers KANBAN-76
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext, RouteHandler } from "../types";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createMachineStore, type MachineStore } from "../services/machine-store";
import { createTaskService, type TaskService } from "../services/tasks";
import { createTasksRouter } from "./tasks";
import { call, makeCtx } from "./tasks-test-support";

const GIT_BOARD = "git-board-abc123";
const BARE_BOARD = "bare-board-abc123";
const scratch: string[] = [];

function repo(withOrigin: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "board-machine-"));
  scratch.push(dir);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore" });
  git("init", "-q");
  if (withOrigin) git("remote", "add", "origin", "https://github.com/acme/app.git");
  return dir;
}

function migratedDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const m of EMBEDDED_MIGRATIONS) db.run(m.sql);
  return db;
}

afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

describe("board_settings.dispatch_machine_id", () => {
  test("the column exists on a database born from zero, nullable, no default", () => {
    const db = migratedDb();
    const col = (db.query("PRAGMA table_info(board_settings)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>)
      .find((c) => c.name === "dispatch_machine_id");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  test("removing the machine clears the rule instead of leaving a dangling id", () => {
    const db = migratedDb();
    const machines = createMachineStore(db, process.cwd());
    const node = machines.upsertNode({ hostname: "pc:3333", name: "PC", baseUrl: "http://127.0.0.1:9443" });
    const svc = createTaskService(db);
    svc.updateBoardSettings(GIT_BOARD, { dispatchMachineId: node.id });
    machines.delete(node.id);
    expect(svc.getBoardSettings(GIT_BOARD).dispatchMachineId).toBeNull();
  });
});

describe("creating a card on a board with a default machine", () => {
  let db: Database; let svc: TaskService; let nodeId: string;
  beforeEach(() => {
    db = migratedDb();
    nodeId = createMachineStore(db, process.cwd()).upsertNode({ hostname: "pc:3333", name: "PC", baseUrl: "http://127.0.0.1:9443" }).id;
    svc = createTaskService(db);
    svc.updateBoardSettings(GIT_BOARD, { dispatchMachineId: nodeId });
  });

  test("the card is born on the board's machine", () => {
    expect(svc.create({ projectId: GIT_BOARD, text: "Sistema il login" }).machineId).toBe(nodeId);
  });

  test("an explicit machine wins, and an explicit null means this machine", () => {
    const other = createMachineStore(db, process.cwd()).upsertNode({ hostname: "nas:3333", name: "NAS", baseUrl: "http://127.0.0.1:9444" }).id;
    expect(svc.create({ projectId: GIT_BOARD, text: "Su un altro", machineId: other }).machineId).toBe(other);
    expect(svc.create({ projectId: GIT_BOARD, text: "Qui", machineId: null }).machineId).toBeNull();
  });

  test("a subtask is born where its board sends cards", () => {
    const parent = svc.create({ projectId: GIT_BOARD, text: "Madre" });
    expect(svc.create({ projectId: GIT_BOARD, text: "Figlia", parentTaskId: parent.id }).machineId).toBe(nodeId);
  });

  test("a board with no rule keeps creating local cards", () => {
    expect(svc.create({ projectId: BARE_BOARD, text: "Locale" }).machineId).toBeNull();
  });

  test("clearing the rule stops the default, and leaves existing cards alone", () => {
    const before = svc.create({ projectId: GIT_BOARD, text: "Prima" });
    expect(svc.updateBoardSettings(GIT_BOARD, { dispatchMachineId: null }).dispatchMachineId).toBeNull();
    expect(svc.create({ projectId: GIT_BOARD, text: "Dopo" }).machineId).toBeNull();
    expect(svc.get(before.id)!.task.machineId).toBe(nodeId);
  });
});

describe("the board routes", () => {
  let db: Database; let router: RouteHandler; let machines: MachineStore;
  let nodeId: string; let localId: string; let plainId: string;
  beforeEach(() => {
    db = migratedDb();
    machines = createMachineStore(db, process.cwd());
    nodeId = machines.upsertNode({ hostname: "pc:3333", name: "PC", baseUrl: "http://127.0.0.1:9443" }).id;
    localId = machines.upsertLocal().id;
    // A row with no base_url that is not this machine: seen once, never paired.
    plainId = "plain-machine";
    db.run(`INSERT INTO machines (id, name, hostname, arch, platform, daemon_version, status, last_heartbeat_at, last_seen_at, created_at, updated_at)
            VALUES (?, 'Vecchio', 'old:1', '', '', '0.0.0', 'offline', 'x', 'x', 'x', 'x')`, [plainId]);
    const paths: Record<string, string> = { [GIT_BOARD]: repo(true), [BARE_BOARD]: repo(false) };
    const ctx = Object.assign(makeCtx(db, []), {
      machineStore: machines,
      projectStore: { get: (id: string) => (paths[id] ? { id, path: paths[id] } : null) },
    }) as unknown as AppContext;
    router = createTasksRouter(ctx);
  });

  const patch = (board: string, dispatchMachineId: unknown) =>
    call(router, "PATCH", `/api/boards/${board}/settings`, { dispatchMachineId });

  test("a paired node on a repo with a git origin is accepted and shows in GET", async () => {
    const res = await patch(GIT_BOARD, nodeId);
    expect(res!.status).toBe(200);
    expect((await res!.json()).dispatchMachineId).toBe(nodeId);
    const got = await call(router, "GET", `/api/boards/${GIT_BOARD}/settings`);
    expect((await got!.json()).dispatchMachineId).toBe(nodeId);
  });

  test("a machine that does not exist is refused with 400", async () => {
    const res = await patch(GIT_BOARD, "no-such-machine");
    expect(res!.status).toBe(400);
    expect((await res!.json()).code).toBe("unknown_machine");
  });

  test("a machine that is not a paired node is refused with 400", async () => {
    const res = await patch(GIT_BOARD, plainId);
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.code).toBe("not_a_node");
    expect(body.error).toContain("Vecchio");
  });

  test("a project without a git origin is refused with 400, and nothing is saved", async () => {
    const res = await patch(BARE_BOARD, nodeId);
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.code).toBe("no_git_origin");
    expect(body.error).toContain("origin");
    const got = await call(router, "GET", `/api/boards/${BARE_BOARD}/settings`);
    expect((await got!.json()).dispatchMachineId).toBeNull();
  });

  test("the local machine means 'here' and needs no origin", async () => {
    const res = await patch(BARE_BOARD, localId);
    expect(res!.status).toBe(200);
    expect((await res!.json()).dispatchMachineId).toBe(localId);
  });

  test("null and the empty string clear the rule; a non-string is refused", async () => {
    await patch(GIT_BOARD, nodeId);
    expect((await (await patch(GIT_BOARD, null))!.json()).dispatchMachineId).toBeNull();
    await patch(GIT_BOARD, nodeId);
    expect((await (await patch(GIT_BOARD, ""))!.json()).dispatchMachineId).toBeNull();
    expect((await patch(GIT_BOARD, 7))!.status).toBe(400);
  });

  test("a PATCH that does not mention the machine leaves the rule alone", async () => {
    await patch(GIT_BOARD, nodeId);
    const res = await call(router, "PATCH", `/api/boards/${GIT_BOARD}/settings`, { dispatchEffort: "high" });
    expect((await res!.json()).dispatchMachineId).toBe(nodeId);
  });

  test("POST on the board: the default applies, an explicit machine wins, an unknown one is refused", async () => {
    await patch(GIT_BOARD, nodeId);
    const create = (extra: Record<string, unknown>) =>
      call(router, "POST", `/api/boards/${GIT_BOARD}/tasks`, { text: "Una card", ...extra });
    expect((await (await create({}))!.json()).machineId).toBe(nodeId);
    expect((await (await create({ machineId: null }))!.json()).machineId).toBeNull();
    expect((await (await create({ machineId: localId }))!.json()).machineId).toBe(localId);
    expect((await create({ machineId: "ghost" }))!.status).toBe(400);
  });
});
