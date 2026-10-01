/**
 * A `run_command` that serves a port and does not wake its chat is a server,
 * not work the chat waits for (BGVIS-08), on the real registry with a real
 * HTTP server: once its port is seen it leaves the chat's background tasks,
 * it is listed among the chat's servers with its address, the chat's
 * processes list it, and when it is stopped the servers say so for a moment.
 * A command that wakes the chat stays background work, port or not.
 *
 * @covers BGVIS-08
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("command-service");
// Before the registry is imported: its boot reads the state folder named then.
setupTestDataDir(join(ROOT, "data"));
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));

const { commandBackgroundWork, commandServices, createProcessesRouter, topicCommandProcesses } = await import("../../server/routes/processes");

let ctx: AppContext;
let processes: ReturnType<typeof createProcessesRouter>;
/** Every command a test ran, with its chat: what `afterAll` makes sure has exited. */
const started: { processId: string; topicId: string }[] = [];

beforeAll(async () => {
  ctx = await createTestAppContext();
  (ctx as { resolveTopicCwd: unknown }).resolveTopicCwd = () => PROJECT;
  processes = createProcessesRouter(ctx);
});
afterAll(async () => {
  // A test that failed before its Stop: stop what it left and wait for the exits.
  const left = started.filter((s) => isRunning(s.topicId, s.processId));
  for (const s of left) await call("POST", `/api/scripts/${s.processId}/stop`).catch(() => {});
  await until(() => !left.some((s) => isRunning(s.topicId, s.processId)));
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

let seq = 0;
function newTopic(): Topic {
  const name = `srv-${++seq}`;
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey: `topic:${name}`, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai", projectPath: PROJECT,
  } as Topic;
  ctx.saveSingleTopic(topic);
  return topic;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://topics.test${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return (await processes(req, url, url.pathname, method)) as Response;
}

/** A port nobody listens on right now. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** A real HTTP server, as a command line the registry runs. */
const serverCommand = (port: number) =>
  `'${process.execPath}' -e 'Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("SRV-OK") })'`;

async function run(topic: Topic, command: string, wake: boolean): Promise<string> {
  const res = await call("POST", `/api/sessions/${encodeURIComponent(topic.sessionKey)}/commands/run`, { command, wake, description: `srv ${seq}` });
  const { processId } = (await res.json()) as { processId: string };
  started.push({ processId, topicId: topic.id });
  return processId;
}

async function until(ok: () => boolean, ms = 12_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(100);
}

/** Does a server still answer on this port. */
const answers = (port: number) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).then((t) => t === "SRV-OK").catch(() => false);

const isRunning = (topicId: string, processId: string) =>
  topicCommandProcesses(topicId).some((p) => p.processId === processId && p.status === "running");

const servicesOf = (topic: Topic) => commandServices().find((r) => r.topicId === topic.id)?.services ?? [];

describe("a command that serves a port without waking the chat", () => {
  test("is a server of the chat once its port is seen, not a task it waits for, and the chat's processes list it", async () => {
    const topic = newTopic();
    const port = freePort();
    const processId = await run(topic, serverCommand(port), false);
    await until(() => servicesOf(topic).length > 0);
    const [service] = servicesOf(topic);
    expect(service?.processId).toBe(processId);
    expect(service?.listen).toEqual([{ host: "127.0.0.1", port }]);
    expect(service?.ended).toBeUndefined();
    // Not background work: no task, no session with work.
    expect(commandBackgroundWork.tasks(topic.sessionKey)).toEqual([]);
    expect(commandBackgroundWork.sessions()).not.toContain(topic.sessionKey);
    // The chat's processes name it, with its port.
    const listed = topicCommandProcesses(topic.id);
    expect(listed.map((p) => [p.processId, p.status, p.ports])).toEqual([[processId, "running", [port]]]);

    // Stopped: the servers say so, then it is a recent process of the chat.
    expect((await call("POST", `/api/scripts/${processId}/stop`)).status).toBe(200);
    await until(() => !!servicesOf(topic)[0]?.ended);
    expect(servicesOf(topic)[0]?.ended).toMatchObject({ stopped: true, exitCode: null });
    expect(topicCommandProcesses(topic.id).map((p) => p.status)).toEqual(["done"]);
    expect(await answers(port)).toBe(false);
  }, 30_000);

  test("a command that wakes the chat stays background work, port or not", async () => {
    const topic = newTopic();
    const port = freePort();
    const processId = await run(topic, serverCommand(port), true);
    // Its port is up (the server answers), and it is still a task the chat waits for.
    let answer = "";
    const end = Date.now() + 12_000;
    while (answer !== "SRV-OK" && Date.now() < end) {
      answer = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => "");
      if (answer !== "SRV-OK") await Bun.sleep(100);
    }
    expect(answer).toBe("SRV-OK");
    expect(commandBackgroundWork.tasks(topic.sessionKey).map((t) => t.processId)).toEqual([processId]);
    expect(servicesOf(topic)).toEqual([]);
    expect((await call("POST", `/api/scripts/${processId}/stop`)).status).toBe(200);
    // The Stop signals in the background: wait for the exit, or the test
    // process ends first and leaves the server running with no one to stop it.
    await until(() => !isRunning(topic.id, processId));
    expect(await answers(port)).toBe(false);
  }, 30_000);
});
