/**
 * `GET /api/scripts` reads ports, and wakes the process detection, only for
 * `?ports=1`: the Processes panel, the one reader that draws them. Every
 * project sidebar polls the same route every 15 s for its running dots, and
 * when that poll read the ports and woke the detection, lsof ran every 4 s for
 * as long as a window was open (238 in 15 minutes on the live server, 15/10).
 *
 * The clock is moved past the port and response caches before each read, so a
 * read that wanted ports would have to spawn: counted from the server's own
 * spawn metrics. One real running command gives the route a pid to look up.
 *
 * @covers PROCESS-10
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const STATE = mkdtempSync(join(tmpdir(), "topics-scripts-ports-state-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { createProcessesRouter, processDetectionViewIsOpen, stopProcessDetectionForTests } = await import("./processes");
const { serverSpawnCounts } = await import("../lib/spawn-metrics");

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), "topics-scripts-ports-project-")));
const TOPIC = { id: "topic-ports", sessionKey: "topic:ports" };

const router = createProcessesRouter({
  db: { query: () => ({ get: () => null }) },
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  broadcastToAll: () => {},
  getTopicBySessionKey: (k: string) => (k === TOPIC.sessionKey ? TOPIC : null),
  resolveTopicCwd: () => PROJECT,
} as never);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await router(req, url, url.pathname, method))!;
}

type Row = { processId: string; status: string; ports?: number[] };
let processId = "";
let clock = Date.now();
/** Past the 2 s response cache and the 5 s port cache: a read that wants ports must spawn. */
const pastTheCaches = () => { clock += 10_000; setSystemTime(new Date(clock)); };
const lsofSpawns = () => Object.values(serverSpawnCounts(clock).counts.lsof).reduce((a, b) => a + b, 0);

beforeAll(async () => {
  const resp = await call("POST", `/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/commands/run`, { command: "sleep 30" });
  expect(resp.status).toBe(200);
  ({ processId } = await resp.json() as { processId: string });
});

afterAll(async () => {
  setSystemTime();
  await call("POST", `/api/scripts/${processId}/stop`);
  // The exit of the command saves the registry: DATA_DIR stays this file's
  // until it has, or the save lands on the live state of the next file.
  for (let i = 0; i < 50; i++) {
    const { scripts } = await (await call("GET", "/api/scripts")).json() as { scripts: Row[] };
    if (scripts.find((s) => s.processId === processId)?.status !== "running") break;
    await Bun.sleep(100);
  }
  stopProcessDetectionForTests();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(STATE, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
});

describe("GET /api/scripts", () => {
  test("a sidebar's poll lists the running row without reading ports or waking the detection", async () => {
    stopProcessDetectionForTests();
    pastTheCaches();
    const before = lsofSpawns();
    const { scripts } = await (await call("GET", "/api/scripts")).json() as { scripts: Row[] };
    expect(scripts.find((s) => s.processId === processId)).toMatchObject({ status: "running", ports: [] });
    expect(lsofSpawns()).toBe(before);
    expect(processDetectionViewIsOpen(clock)).toBe(false);
  });

  test("the Processes panel's poll wakes the detection and reads the ports", async () => {
    stopProcessDetectionForTests();
    pastTheCaches();
    const before = lsofSpawns();
    const resp = await call("GET", "/api/scripts?ports=1");
    expect(resp.status).toBe(200);
    expect(processDetectionViewIsOpen(clock)).toBe(true);
    // Where the machine has a port probe (lsof on macOS, ss on Linux) the read spawned it.
    if (Bun.which("lsof") || Bun.which("ss") || Bun.which("lsof", { PATH: "/usr/sbin" })) {
      expect(lsofSpawns()).toBe(before + 1);
    }
    stopProcessDetectionForTests();
  });
});
