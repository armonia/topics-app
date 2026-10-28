/**
 * created_by on the board create route: WHO a card says opened it cannot be
 * decided by a header the caller picks. `X-Topics-Action-Origin: interface` makes
 * a card a person's only when the caller carries no agent credential.
 * @covers KANBAN-05
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("created_by is not spoofable by an agent that holds a credential", () => {
  const DAEMON_TOKEN = "d".repeat(64);
  let db: Database; let router: any; let home: string; let savedHome: string | undefined;
  beforeEach(() => {
    db = freshDb();
    router = createTasksRouter(makeCtx(db, []));
    home = mkdtempSync(join(tmpdir(), "created-by-daemon-"));
    writeFileSync(join(home, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: DAEMON_TOKEN, startedAt: "x" }));
    savedHome = process.env.TOPICS_HOME;
    process.env.TOPICS_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.TOPICS_HOME; else process.env.TOPICS_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const create = async (body: Record<string, unknown>, headers: Record<string, string>) =>
    (await (await call(router, "POST", "/api/boards/pX/tasks", body, headers))!.json()).createdBy;

  test("the daemon token plus the interface header is still automation", async () => {
    const withToken = { "X-Daemon-Token": DAEMON_TOKEN, "X-Topics-Action-Origin": "interface" };
    expect(await create({ text: "spoof" }, withToken)).toBe("agent:api");
    expect(await create({ text: "spoof named", createdBy: "agent:jarvis" }, withToken)).toBe("agent:jarvis");
    // Even the body cannot hand an agent the human label.
    expect(await create({ text: "spoof human", createdBy: "human" }, withToken)).toBe("agent:api");
    expect(await create({ text: "bearer", createdBy: "agent:jarvis" }, {
      Authorization: `Bearer ${DAEMON_TOKEN}`, "X-Topics-Action-Origin": "interface",
    })).toBe("agent:jarvis");
  });

  test("a wrong token proves nothing: the interface header without a valid credential is the interface", async () => {
    expect(await create({ text: "ui" }, { "X-Daemon-Token": "e".repeat(64), "X-Topics-Action-Origin": "interface" })).toBe("human");
    expect(await create({ text: "ui" }, { "X-Topics-Action-Origin": "interface" })).toBe("human");
  });
});
