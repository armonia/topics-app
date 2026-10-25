/**
 * A card in review keeps its group; its approval to done closes the group.
 *
 * @covers CARDPROCESS-01
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "topics-card-process-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = stateDir;
const { freshDb, makeCtx, call } = await import("./tasks-test-support");
const { createTasksRouter } = await import("./tasks");
const { stopCardCommandProcesses, stopTopicCommandProcesses } = await import("./processes");
const { captureProcessGroup, processGroupAlive, registerCommandProcessGroup } = await import("../lib/command-process-groups");
const { archiveTopicFully } = await import("../services/archive-topic");
const owned: Array<{ proc: ReturnType<typeof Bun.spawn>; pgid: number }> = [];

afterAll(async () => {
  for (const { proc } of owned) { try { proc.kill("SIGKILL"); } catch {} }
  await Promise.all(owned.map(({ proc }) => Promise.race([proc.exited, Bun.sleep(1000)])));
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(stateDir, { recursive: true, force: true });
});

test("review preserves a live group; approving done stops that card's group", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO topics (id, session_key, project_path) VALUES ('top-s1', 's1', '/proj/one')").run();
  const router = createTasksRouter(makeCtx(db, []), undefined, { stopCardProcesses: stopCardCommandProcesses });
  const task = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "card with command", status: "todo" }))!.json() as { id: string };
  db.prepare("UPDATE tasks SET assigned_topic_id = 'top-s1', status = 'in_progress' WHERE id = ?").run(task.id);

  const proc = Bun.spawn([process.platform === "darwin" ? "/bin/zsh" : "/bin/sh", "-c", "exec sleep 90"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  const identity = captureProcessGroup(proc.pid)!;
  owned.push({ proc, pgid: identity.pgid });
  registerCommandProcessGroup({
    processId: crypto.randomUUID(), ownerKey: "s1", cardId: task.id, topicId: "top-s1",
    pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
    startedAt: new Date().toISOString(),
  });

  const inReview = await call(router, "PATCH", `/api/boards/pX/tasks/${task.id}`, { status: "review" });
  expect(inReview?.status).toBe(200);
  await Bun.sleep(150);
  expect(processGroupAlive(identity.pgid)).toBe(true);

  const approved = await call(router, "POST", `/api/boards/pX/tasks/${task.id}/review`, { decision: "approve" });
  expect(approved?.status).toBe(200);
  expect((await approved!.json()).status).toBe("done");
  const deadline = Date.now() + 3000;
  while (processGroupAlive(identity.pgid) && Date.now() < deadline) await Bun.sleep(50);
  expect(processGroupAlive(identity.pgid)).toBe(false);
});

test("archiving a card through the board stops its registered group", async () => {
  const db = freshDb();
  const router = createTasksRouter(makeCtx(db, []), undefined, { stopCardProcesses: stopCardCommandProcesses });
  const task = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "card to archive", status: "todo" }))!.json() as { id: string };
  const proc = Bun.spawn([process.platform === "darwin" ? "/bin/zsh" : "/bin/sh", "-c", "exec sleep 90"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  const identity = captureProcessGroup(proc.pid)!;
  owned.push({ proc, pgid: identity.pgid });
  registerCommandProcessGroup({
    processId: crypto.randomUUID(), ownerKey: "archive-session", cardId: task.id, topicId: null,
    pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
    startedAt: new Date().toISOString(),
  });

  const archived = await call(router, "DELETE", `/api/boards/pX/tasks/${task.id}`);
  expect(archived?.status).toBe(200);
  const deadline = Date.now() + 3000;
  while (processGroupAlive(identity.pgid) && Date.now() < deadline) await Bun.sleep(50);
  expect(processGroupAlive(identity.pgid)).toBe(false);
});

test("archiving a topic stops its registered command groups", async () => {
  const proc = Bun.spawn([process.platform === "darwin" ? "/bin/zsh" : "/bin/sh", "-c", "exec sleep 90"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  const identity = captureProcessGroup(proc.pid)!;
  owned.push({ proc, pgid: identity.pgid });
  const topicId = "topic-archive-process";
  registerCommandProcessGroup({
    processId: crypto.randomUUID(), ownerKey: "topic-session", cardId: null, topicId,
    pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
    startedAt: new Date().toISOString(),
  });
  const topic = { id: topicId, sessionKey: "topic-session", archived: false } as any;
  const archived = archiveTopicFully({
    getTopicById: () => topic,
    saveSingleTopic: () => {},
    loadUnread: () => ({}),
    saveUnreadEntries: () => {},
    broadcastToAll: () => {},
    purgeFromUiState: () => ({ ok: true }),
    stopProcesses: stopTopicCommandProcesses,
  }, topicId);

  expect(archived.ok).toBe(true);
  const deadline = Date.now() + 3000;
  while (processGroupAlive(identity.pgid) && Date.now() < deadline) await Bun.sleep(50);
  expect(processGroupAlive(identity.pgid)).toBe(false);
});
