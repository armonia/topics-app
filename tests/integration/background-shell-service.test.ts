/**
 * A dev server an agent starts with `Bash` and `run_in_background` is the
 * chat's server, not work the chat waits for (BGVIS-09), on the real registry
 * with real processes: this test process plays the CLI and starts each shell
 * the way Claude Code does (`/bin/sh -c "eval '<command>' …"`, the server its
 * child), the shell is registered under the id the CLI gave it, and the chat's
 * task map holds that same id, as the CLI's snapshot writes it.
 *
 * Once the registry's watch sees the port: the shell is among the chat's
 * `services` with its address, and the map, rewritten from the same snapshot
 * (what `server.ts` does on every registry change), no longer holds it, so the
 * chat is not `working`. A shell that listens on nothing stays a task. When the
 * server exits and the CLI drops it from its list, its row closes at once and
 * the `services` say it ended.
 *
 * @covers BGVIS-09
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestAppContext, freePort, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext, Topic } from "../../server/types";
import type { AttentionTaskMap } from "../../shared/attention";
import { topicSubject } from "../../shared/attention";
import { shellProcessKey } from "../../shared/background-shell-registry";

const ROOT = testTmpDir("bg-shell-service");
// Before the registry is first used: its load reads the state folder named then.
setupTestDataDir(join(ROOT, "data"));
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));
/** Present = every process this file started exits by itself. */
const STOP = join(ROOT, "stop");

const processes = await import("../../server/routes/processes");
const { commandServices, createProcessesRouter, isChatServerTask, listBackgroundShells, registerBackgroundShell, settleEndedShells } = processes;
const { configureAttentionStore, getAttention, setBackgroundTasks, turnEnded, turnStarted } = await import("../../server/attention/store");
const { observeCommandChanged } = await import("../../server/lib/command-background");
const { setSessionCliPid, clearSessionCliPid } = await import("../../server/providers/session-pids");

let ctx: AppContext;
const shells: Array<ReturnType<typeof Bun.spawn>> = [];
/** What the CLI's snapshot lists, per session: the map `server.ts` rewrites from it on every registry change. */
const cliSnapshot = new Map<string, { subject: string; tasks: AttentionTaskMap }>();

// A process that serves `port` (or none, given 0) until the STOP file appears.
const PROC = join(ROOT, "proc.ts");
writeFileSync(PROC, [
  `import { existsSync } from "node:fs";`,
  `const port = Number(process.argv[2]);`,
  `if (port) Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("BGSRV-OK") });`,
  `setInterval(() => { if (existsSync(${JSON.stringify(STOP)})) process.exit(0); }, 100);`,
].join("\n"));

beforeAll(async () => {
  ctx = await createTestAppContext();
  createProcessesRouter(ctx); // the registry's broadcast context: its pushes reach the observer below
  configureAttentionStore({ isServerTask: isChatServerTask });
  observeCommandChanged((sessionKey) => {
    const snap = cliSnapshot.get(sessionKey);
    if (snap) setBackgroundTasks(snap.subject, snap.tasks);
  });
});
afterAll(async () => {
  writeFileSync(STOP, "");
  await Promise.all(shells.map((s) => s.exited));
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

let seq = 0;
function newTopic(): Topic {
  const name = `bgsrv-${++seq}`;
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey: `topic:${name}`, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "claude-code", projectPath: PROJECT,
  } as Topic;
  ctx.saveSingleTopic(topic);
  return topic;
}

/** Start `command` as Claude Code starts a background Bash: a shell that evals it, child of the CLI (this process). */
function startShell(command: string): ReturnType<typeof Bun.spawn> {
  const shell = Bun.spawn(["/bin/sh", "-c", `eval '${command}' < /dev/null && pwd -P >/dev/null`], { cwd: PROJECT, stdout: "ignore", stderr: "ignore" });
  shells.push(shell);
  return shell;
}

async function until(ok: () => boolean | Promise<boolean>, ms = 12_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await Bun.sleep(100);
}

const answers = (port: number) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).then((t) => t === "BGSRV-OK").catch(() => false);
const servicesOf = (topic: Topic) => commandServices().find((r) => r.topicId === topic.id)?.services ?? [];
const shellPid = (sessionKey: string, shellId: string) => listBackgroundShells().find((s) => s.sessionKey === sessionKey && s.shellId === shellId)?.pid ?? null;

describe("a chat's background Bash", () => {
  test("that listens on a port is the chat's server and leaves its task map; one that listens on nothing stays a task", async () => {
    const dev = newTopic();
    const build = newTopic();
    const port = freePort();
    const devCommand = `${process.execPath} ${PROC} ${port}`;
    const buildCommand = `${process.execPath} ${PROC} 0`;
    const startedAt = new Date().toISOString();

    // The CLI starts both shells, then lists each task under the id it gave it.
    const devShell = startShell(devCommand);
    startShell(buildCommand);
    await until(() => answers(port));
    expect(await answers(port)).toBe(true);
    for (const [topic, id, label] of [[dev, "bdev01", "bun run dev"], [build, "bbuild1", "bun run build"]] as const) {
      setSessionCliPid(topic.sessionKey, process.pid);
      const tasks = { [id]: { kind: "bash", label, startedAt } };
      cliSnapshot.set(topic.sessionKey, { subject: topicSubject(topic.id), tasks });
      turnStarted(topicSubject(topic.id));
      turnEnded(topicSubject(topic.id), { turnId: `m-${id}`, outcome: "done", background: tasks });
      expect(getAttention(topicSubject(topic.id)).state).toBe("working");
    }
    // The chat route registers each shell from the CLI's answer ("running in background with ID: ...").
    registerBackgroundShell({ sessionKey: dev.sessionKey, topicId: dev.id, shellId: "bdev01", command: devCommand, cwd: PROJECT, ownerPid: process.pid });
    registerBackgroundShell({ sessionKey: build.sessionKey, topicId: build.id, shellId: "bbuild1", command: buildCommand, cwd: PROJECT, ownerPid: process.pid });
    // Found at once in the CLI's tree: no detector runs in this file, so nothing else could find them.
    await until(() => shellPid(dev.sessionKey, "bdev01") !== null && shellPid(build.sessionKey, "bbuild1") !== null, 3_000);
    expect(shellPid(dev.sessionKey, "bdev01")).not.toBeNull();
    expect(shellPid(build.sessionKey, "bbuild1")).not.toBeNull();

    await until(() => servicesOf(dev).length > 0);
    const [service] = servicesOf(dev);
    expect(service?.processId).toBe(shellProcessKey(dev.sessionKey, "bdev01"));
    expect(service?.listen).toEqual([{ host: "127.0.0.1", port }]);
    expect(service?.ended).toBeUndefined();
    // The task map, rewritten from the CLI's same snapshot, no longer holds it.
    expect(isChatServerTask(topicSubject(dev.id), "bdev01")).toBe(true);
    expect(getAttention(topicSubject(dev.id)).background).toEqual([]);
    expect(getAttention(topicSubject(dev.id)).state).not.toBe("working");
    // The same pass saw the other shell's tree listen on nothing: still a task, still at work.
    expect(servicesOf(build)).toEqual([]);
    expect(getAttention(topicSubject(build.id)).background.map((t) => t.id)).toEqual(["bbuild1"]);
    expect(getAttention(topicSubject(build.id)).state).toBe("working");

    // The server exits; the CLI drops it from its list, and the row closes now.
    writeFileSync(STOP, "");
    await devShell.exited;
    cliSnapshot.set(dev.sessionKey, { subject: topicSubject(dev.id), tasks: {} });
    await settleEndedShells(dev.sessionKey);
    expect(servicesOf(dev)[0]?.ended).toMatchObject({ stopped: false });
    expect(isChatServerTask(topicSubject(dev.id), "bdev01")).toBe(false);
    expect(await answers(port)).toBe(false);
    clearSessionCliPid(dev.sessionKey);
    clearSessionCliPid(build.sessionKey);
    expect(existsSync(STOP)).toBe(true);
  }, 30_000);
});
