/**
 * THE SUB-AGENT DOOR, IN BOTH MODES, read off the real settings row.
 *
 * "By resources" ignores the number of agents (the dispatcher does), so the
 * door must not apply the cap as a count there: with four cards admitted by the
 * budget every child took a 429, and with one card the same door opened three
 * unchecked. The door asks the dispatcher's own gate instead, priced for one
 * child. `server.ts` hands it that gate; both facts are pinned below.
 *
 * @covers KANBAN-75
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { boardAgentCap, boardSpawnMode, setChildAdmissionPreview } from "./terminal";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "spawn-door-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  initDatabase(tmpRoot);
});

afterAll(() => {
  setChildAdmissionPreview(null);
  closeDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setMode(mode: "count" | "resources", max = 4): void {
  getDatabase()
    .prepare(
      `INSERT INTO board_settings (project_id, max_agents, max_agents_auto, max_agents_mode) VALUES ('*', ?, 0, ?)
       ON CONFLICT(project_id) DO UPDATE SET max_agents = excluded.max_agents, max_agents_auto = 0, max_agents_mode = excluded.max_agents_mode`,
    )
    .run(max, mode === "resources" ? "resources" : null);
}

describe("boardSpawnMode", () => {
  test("in count mode the door keeps the cap and never asks the machine", () => {
    setMode("count");
    let asked = 0;
    setChildAdmissionPreview(() => { asked++; return { admit: false, blockedBy: "cpu", firstAgentExempt: false, costCoreUnits: 0 }; });
    expect(boardSpawnMode()).toEqual({});
    expect(asked).toBe(0);
    expect(boardAgentCap()).toBe(4);
  });

  test("in resources mode the door carries the machine's verdict for a child", () => {
    setMode("resources");
    const held = { admit: false, blockedBy: "memory" as const, firstAgentExempt: false, costCoreUnits: 0 };
    setChildAdmissionPreview(() => held);
    expect(boardSpawnMode()).toEqual({ resources: { admission: held } });
  });

  test("in resources mode a gate that cannot answer, or throws, reads as unmeasurable", () => {
    setMode("resources");
    setChildAdmissionPreview(null);
    expect(boardSpawnMode()).toEqual({ resources: { admission: null } });
    setChildAdmissionPreview(() => { throw new Error("no sample"); });
    expect(boardSpawnMode()).toEqual({ resources: { admission: null } });
  });
});

describe("the wiring", () => {
  test("the route passes the mode to the one rule, and server.ts hands over the dispatcher's child gate", () => {
    const route = readFileSync(join(import.meta.dir, "terminal.ts"), "utf8");
    const server = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
    expect(route).toContain("boardSpawnRefusal(getDatabase(), { parentSessionKey: parentKey, cap: boardAgentCap(), ...boardSpawnMode() })");
    expect(server).toContain("setChildAdmissionPreview(() => taskDispatcher.childAdmissionPreview?.() ?? null)");
  });
});
