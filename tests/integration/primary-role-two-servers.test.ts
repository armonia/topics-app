/**
 * TWO REAL SERVERS, ONE PRIMARY: THE OTHER ONE CLAIMS NOTHING, AND A STALE EPOCH IS REFUSED.
 *
 * Both servers boot through the real entry point (`bun run server.ts`) as child
 * processes, each with its own data folder, its own main port, both tunnel
 * ports and the model proxy port. The primary is chosen the way production
 * keeps it: `<APP_DATA_DIR>/primary-state.json`, written before the boot.
 *
 *   1. Default unchanged: a virgin server (no primary ever chosen) claims a
 *      todo card and lets requests with no epoch header through, on the main
 *      port (`/api/nodes/*`), the model proxy and both tunnel ports.
 *   2. A is the primary at epoch 2 (its own machine id, read from its first
 *      boot). A refuses epoch 1 with `stale_primary_epoch` on the same four
 *      doors, and lets epoch 2 or no header through. A still claims cards.
 *   3. B boots virgin (epoch 0, no primary). A pairs B as a node through the
 *      real pairing routes, over B's tunnel port (where the node session
 *      cookie is what authenticates): the request declares A's machine id and
 *      B records it as its channel. A's heartbeat probe reaches B carrying
 *      epoch 2, and B adopts {A, 2}: nothing is planted by hand.
 *   4. Nobody else moves an epoch: loopback calls on A and on B, a second
 *      owner device paired on B, and B as a node holding a model token on A's
 *      proxy all declare higher epochs and change nothing. A keeps claiming
 *      cards. The proxy refuses a stale epoch but never adopts one.
 *   5. Within a window longer than the grace timer and the scheduled-cards
 *      interval, B claims no card: not a todo card, not the card whose
 *      blocker is moved to done, not a memory-held card started by hand, and
 *      its due scheduled card does not fire.
 *
 * "Claimed" is read from the outside after the fact. This bench has no coding
 * model, so a card the dispatcher claims comes back parked in backlog with the
 * "No eligible coding model" reason; a card nobody claimed stays in todo.
 *
 *   6. A THIRD server D, not the fleet's primary, pairs B after A already did:
 *      B's channel stays A's device, never D's (the defect this test guards:
 *      "last pairing wins" let any server that paired a node steal its
 *      channel). A, restarted at a higher epoch, is still adopted by B
 *      through the unchanged channel. D, independently declaring an even
 *      higher epoch, is never adopted, because it is not the channel's device.
 *
 * @covers MACHINE-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, PROJECT_ROOT, spawnedServerHostEnv, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";

const EPOCH_HEADER = "x-topics-primary-epoch";
const STALE_CODE = "stale_primary_epoch";
/** Longer than the dispatcher grace (6 s) and the scheduled-cards interval (15 s). */
const QUIET_WINDOW_MS = 22_000;

interface ServerUnderTest {
  name: string;
  root: string;
  port: number;
  tunnelPort: number;
  tunnelHttpPort: number;
  modelProxyPort: number;
  child: ReturnType<typeof Bun.spawn> | null;
  boots: number;
}

interface TaskView {
  id: string;
  projectId: string;
  status: string;
  dispatchState: string | null;
  dispatchError: string | null;
  dispatchAttempts: number;
  assignedTopicId: string | null;
}

const running: ServerUnderTest[] = [];

function makeServer(name: string): ServerUnderTest {
  const root = testTmpDir(`primary-${name}`);
  for (const dir of ["data", "home", "app-data", "topics-home", "public"]) mkdirSync(join(root, dir), { recursive: true });
  return { name, root, port: freePort(), tunnelPort: freePort(), tunnelHttpPort: freePort(), modelProxyPort: freePort(), child: null, boots: 0 };
}

const base = (s: ServerUnderTest) => `http://127.0.0.1:${s.port}`;
const logOf = (s: ServerUnderTest) => {
  try { return readFileSync(join(s.root, `server-${s.boots}.log`), "utf8").slice(-4000); } catch { return ""; }
};

async function boot(s: ServerUnderTest): Promise<void> {
  s.boots += 1;
  const home = join(s.root, "home");
  const logFd = openSync(join(s.root, `server-${s.boots}.log`), "w");
  s.child = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: PROJECT_ROOT,
    // Built from scratch, never spread from process.env: an inherited port or
    // data dir would point the child at the live app.
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      NO_TLS: "1",
      BUN_PORT: String(s.port),
      PORT: String(s.port),
      DATA_DIR: join(s.root, "data"),
      TOPICS_DATA_DIR: join(s.root, "data"),
      HOME: home,
      // os.homedir() reads USERPROFILE on Windows: without it the child would see the real home.
      USERPROFILE: home,
      APP_DATA_DIR: join(s.root, "app-data"),
      TOPICS_HOME: join(s.root, "topics-home"),
      TOPICS_PUBLIC_DIR: join(s.root, "public"),
      TOPICS_BROWSER_SWEEP: "0",
      TOPICS_DISABLE_PTY_BRIDGE: "1",
      TOPICS_PTY_SOCKET: join(s.root, "pty.sock"),
      TOPICS_AI_BRIDGE: "0",
      TOPICS_AI_BRIDGE_SOCKET: join(s.root, "ai.sock"),
      TOPICS_HUB_URL: "http://127.0.0.1:9",
      TOPICS_TUNNEL_PORT: String(s.tunnelPort),
      TOPICS_TUNNEL_HTTP_PORT: String(s.tunnelHttpPort),
      TOPICS_MODEL_PROXY_PORT: String(s.modelProxyPort),
      ...spawnedServerHostEnv(),
    },
    stdout: logFd,
    stderr: logFd,
  });
  closeSync(logFd);
  if (!running.includes(s)) running.push(s);
  const until = Date.now() + slackMs(90_000);
  while (Date.now() < until) {
    if (s.child.exitCode !== null) break;
    const res = await fetch(`${base(s)}/api/system/status`).catch(() => null);
    if (res?.ok) return;
    await Bun.sleep(200);
  }
  throw new Error(`server ${s.name} boot ${s.boots} did not answer\n${logOf(s)}`);
}

async function stop(s: ServerUnderTest): Promise<void> {
  if (!s.child) return;
  s.child.kill("SIGTERM");
  await Promise.race([s.child.exited, Bun.sleep(slackMs(20_000))]);
  if (s.child.exitCode === null) s.child.kill("SIGKILL");
  await s.child.exited;
  s.child = null;
}

function writePrimaryState(s: ServerUnderTest, primaryMachineId: string, epoch: number): void {
  writeFileSync(join(s.root, "app-data", "primary-state.json"), JSON.stringify({ primaryMachineId, epoch, since: new Date().toISOString() }));
}

function primaryRow(s: ServerUnderTest): { primary_machine_id: string | null; epoch: number } {
  return withDb(s, (db) => db.query("SELECT primary_machine_id, epoch FROM primary_state WHERE id = 1").get() as { primary_machine_id: string | null; epoch: number });
}

function channelOf(s: ServerUnderTest): { channel_device_id: string | null; channel_machine_id: string | null } | null {
  return withDb(s, (db) => db.query("SELECT channel_device_id, channel_machine_id FROM primary_state WHERE id = 1").get() as { channel_device_id: string | null; channel_machine_id: string | null } | null);
}

async function api<T>(s: ServerUnderTest, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base(s)}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${s.name} ${method} ${path} answered ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** A project with auto-dispatch on; returns the board id the cards live under. */
async function autoDispatchBoard(s: ServerUnderTest, name: string): Promise<string> {
  const dir = join(s.root, "projects", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  const project = await api<{ id: string }>(s, "POST", "/api/projects", { name, path: realpathSync(dir) });
  await api(s, "PATCH", `/api/boards/${project.id}/settings`, { autoDispatch: true, dispatchUseWorktree: false });
  return project.id;
}

async function createCard(s: ServerUnderTest, board: string, body: Record<string, unknown>): Promise<TaskView> {
  return api<TaskView>(s, "POST", `/api/boards/${board}/tasks`, body);
}

async function readCard(s: ServerUnderTest, card: TaskView): Promise<TaskView> {
  const view = await api<{ task: TaskView }>(s, "GET", `/api/boards/${card.projectId}/tasks/${card.id}`);
  return view.task;
}

/** The dispatcher's claim ran on this card: it left todo, spent an attempt, or got a chip other than "queued". */
function claimed(t: TaskView): boolean {
  return t.status !== "todo" || t.dispatchAttempts > 0 || t.assignedTopicId !== null
    || (t.dispatchState !== null && t.dispatchState !== "queued");
}

async function waitClaimed(s: ServerUnderTest, card: TaskView): Promise<TaskView> {
  const until = Date.now() + slackMs(40_000);
  let last = card;
  while (Date.now() < until) {
    last = await readCard(s, card);
    if (claimed(last)) return last;
    await Bun.sleep(500);
  }
  throw new Error(`${s.name} never claimed card ${card.id}: ${JSON.stringify(last)}\n${logOf(s)}`);
}

function withDb<T>(s: ServerUnderTest, fn: (db: Database) => T): T {
  const db = new Database(join(s.root, "data", "topics.db"));
  try {
    db.run("PRAGMA busy_timeout = 10000");
    return fn(db);
  } finally { db.close(); }
}

async function status(url: string, epoch?: string, init: RequestInit = {}): Promise<{ status: number; code: string | null }> {
  const headers = new Headers(init.headers);
  if (epoch !== undefined) headers.set(EPOCH_HEADER, epoch);
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let code: string | null = null;
  try { code = (JSON.parse(text) as { code?: string }).code ?? null; } catch { /* not JSON */ }
  return { status: res.status, code };
}

/** The four doors a replaced primary could knock on: nodes API, model proxy, TLS tunnel, plain tunnel. */
function doors(s: ServerUnderTest): Record<string, (epoch?: string) => Promise<{ status: number; code: string | null }>> {
  const messages = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) };
  return {
    nodes: (epoch) => status(`${base(s)}/api/nodes/delegated-requests`, epoch),
    modelProxy: (epoch) => status(`http://127.0.0.1:${s.modelProxyPort}/v1/messages`, epoch, messages),
    tunnel: (epoch) => status(`http://127.0.0.1:${s.tunnelPort}/api/system/status`, epoch),
    tunnelHttp: (epoch) => status(`http://127.0.0.1:${s.tunnelHttpPort}/api/system/status`, epoch),
  };
}

const serverA = makeServer("a");
const serverB = makeServer("b");
let machineA = "";
/** B's row on A, written by the pairing. */
let nodeBOnA = "";

afterAll(async () => {
  await Promise.all(running.map((s) => stop(s)));
});

describe("default unchanged: no primary chosen", () => {
  test("a virgin server claims a todo card and lets requests without an epoch through", async () => {
    await boot(serverA);
    const board = await autoDispatchBoard(serverA, "virgin-board");
    const card = await createCard(serverA, board, { text: "virgin todo card", status: "todo" });
    const after = await waitClaimed(serverA, card);
    expect(after.dispatchError ?? "", "the claim ran and reached the model choice").toMatch(/coding model/);

    for (const [door, call] of Object.entries(doors(serverA))) {
      expect((await call()).status, `${door} without an epoch header`).not.toBe(409);
    }

    const { machines } = await api<{ machines: { id: string; baseUrl: string | null }[] }>(serverA, "GET", "/api/machines");
    const local = machines.filter((m) => m.baseUrl === null);
    expect(local.length, "a virgin server knows only its own machine").toBe(1);
    machineA = local[0]!.id;
    await stop(serverA);
  }, 180_000);
});

describe("A is the primary at epoch 2, B is not", () => {
  beforeAll(async () => {
    if (!machineA) throw new Error("the first boot of A did not record its machine id");
    writePrimaryState(serverA, machineA, 2);
    // B is a virgin node: no primary chosen, epoch 0, until the pairing teaches it.
    await Promise.all([boot(serverA), boot(serverB)]);
    expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: null, epoch: 0 });
  }, 200_000);

  test("A refuses epoch 1 with stale_primary_epoch on nodes, model proxy and both tunnel ports; epoch 2 and no header pass", async () => {
    for (const [door, call] of Object.entries(doors(serverA))) {
      const stale = await call("1");
      expect(stale, `${door} with epoch 1`).toEqual({ status: 409, code: STALE_CODE });
      expect((await call("2")).status, `${door} with epoch 2`).not.toBe(409);
      expect((await call()).status, `${door} without an epoch header`).not.toBe(409);
    }
  }, 60_000);

  test("an unauthenticated caller declaring the next epoch changes nothing on A", async () => {
    const claim = {};
    // Epoch 3, one above A: only authentication stops it.
    // From outside (the tunnel ports carry no owner session) and on the model proxy without a token.
    const anonymous = [
      status(`http://127.0.0.1:${serverA.tunnelPort}/api/nodes/delegated-requests`, "3", { headers: claim }),
      status(`http://127.0.0.1:${serverA.tunnelHttpPort}/api/nodes/delegated-requests`, "3", { headers: claim }),
      status(`http://127.0.0.1:${serverA.modelProxyPort}/v1/messages`, "3", { method: "POST", headers: { ...claim, "content-type": "application/json" }, body: "{}" }),
    ];
    for (const res of await Promise.all(anonymous)) expect(res.status, "refused for lack of credentials").toBe(401);
    // A path the access gate lets through with no identity reaches the nodes router: still no adoption.
    const exempt = await status(`http://127.0.0.1:${serverA.tunnelPort}/api/nodes/delegated-requests`, "3", {
      method: "POST", headers: { ...claim, "content-type": "application/json" }, body: "{}",
    });
    expect(exempt.status).not.toBe(409);
    // Had epoch 3 been adopted, epoch 2 would now be stale.
    for (const [door, call] of Object.entries(doors(serverA))) {
      expect((await call("2")).status, `${door} with epoch 2 after the anonymous claim`).not.toBe(409);
    }
    const row = withDb(serverA, (db) => db.query("SELECT epoch FROM primary_state WHERE id = 1").get() as { epoch: number });
    expect(row.epoch).toBe(2);
  }, 60_000);

  test("A pairs virgin B as a node: B records A as its channel and adopts epoch 2 from A's heartbeat", async () => {
    // The real pairing: A asks through B's tunnel port, B's owner approves, A collects the node session.
    const opened = await api<{ pairingId: string }>(serverA, "POST", "/api/machines/pair", { baseUrl: `http://127.0.0.1:${serverB.tunnelHttpPort}` });
    const { requests } = await api<{ requests: { id: string }[] }>(serverB, "GET", "/api/auth/pair/pending");
    expect(requests).toHaveLength(1);
    const approved = await api<{ deviceId: string }>(serverB, "POST", "/api/auth/pair/approve", { requestId: requests[0]!.id });
    const paired = await api<{ state: string; machine?: { id: string } }>(serverA, "GET", `/api/machines/pair/${opened.pairingId}`);
    expect(paired.state).toBe("approved");
    nodeBOnA = paired.machine!.id;
    expect(channelOf(serverB), "the pairing recorded A as B's channel").toEqual({ channel_device_id: approved.deviceId, channel_machine_id: machineA });

    // The heartbeat probe calls B's /api/nodes/* every 30 s with A's epoch header.
    const until = Date.now() + slackMs(45_000);
    while (Date.now() < until && primaryRow(serverB).epoch !== 2) await Bun.sleep(500);
    expect(primaryRow(serverB), `B adopted the epoch A sent
${logOf(serverB)}`).toMatchObject({ primary_machine_id: machineA, epoch: 2 });
    expect(logOf(serverB)).toContain(`[primary] adopted epoch 2 from ${machineA}`);
    expect(JSON.parse(readFileSync(join(serverB.root, "app-data", "primary-state.json"), "utf8"))).toMatchObject({ primaryMachineId: machineA, epoch: 2 });
    expect(primaryRow(serverA)).toMatchObject({ primary_machine_id: machineA, epoch: 2 });
  }, 120_000);

  test("loopback on A and on B, and a second owner device on B, declare higher epochs and move nothing", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await status(`${base(serverA)}/api/nodes/delegated-requests`, String(3 + i))).status).not.toBe(409);
      expect((await status(`${base(serverB)}/api/nodes/delegated-requests`, String(3 + i))).status).not.toBe(409);
    }
    // A second device paired on B as owner (a phone, a browser): authenticated, and not the channel.
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const asked = await (await fetch(`${tunnel}/api/auth/pair/request`, { method: "POST" })).json() as { requestId: string; claim: string };
    await api(serverB, "POST", "/api/auth/pair/approve", { requestId: asked.requestId });
    const collected = await fetch(`${tunnel}/api/auth/pair/status?requestId=${asked.requestId}&claim=${asked.claim}`);
    const cookie = (collected.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie, "the second device received its session").toContain("=");
    for (const epoch of ["3", "99"]) {
      const res = await status(`${tunnel}/api/nodes/delegated-requests`, epoch, { headers: { cookie } });
      expect(res.status, "the device is authenticated").not.toBe(401);
    }
    expect(primaryRow(serverA)).toMatchObject({ primary_machine_id: machineA, epoch: 2 });
    expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: machineA, epoch: 2 });
    expect(channelOf(serverB)?.channel_machine_id, "a pairing that declares no machine leaves the channel alone").toBe(machineA);
  }, 60_000);

  test("a paired node with a valid model token declaring a huge epoch on the proxy changes nothing on A", async () => {
    if (!nodeBOnA) throw new Error("the pairing test did not record B's machine id on A");
    const { token } = await api<{ token: string }>(serverA, "POST", `/api/machines/${nodeBOnA}/model-token`);
    // A huge epoch, and the next one: only "the proxy never adopts" stops either.
    for (const epoch of [String(Number.MAX_SAFE_INTEGER), "3"]) {
      const res = await status(`http://127.0.0.1:${serverA.modelProxyPort}/v1/messages/count_tokens`, epoch, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-test", messages: [] }),
      });
      expect(res.status, `epoch ${epoch}: the token is valid, the proxy let the caller in`).not.toBe(401);
    }
    expect(primaryRow(serverA)).toMatchObject({ primary_machine_id: machineA, epoch: 2 });
    expect(JSON.parse(readFileSync(join(serverA.root, "app-data", "primary-state.json"), "utf8"))).toMatchObject({ primaryMachineId: machineA, epoch: 2 });
    for (const [door, call] of Object.entries(doors(serverA))) {
      expect((await call("2")).status, `${door} with epoch 2 after the node's claim`).not.toBe(409);
    }
  }, 60_000);

  test("A, the primary, still claims a todo card after the anonymous and the node claims", async () => {
    const board = await autoDispatchBoard(serverA, "primary-board");
    const card = await createCard(serverA, board, { text: "primary todo card", status: "todo" });
    const after = await waitClaimed(serverA, card);
    expect(after.dispatchError ?? "").toMatch(/coding model/);
  }, 60_000);

  test("B claims no card: todo, blocker done, manual start, scheduled card", async () => {
    // A todo card: the go-ahead of a human dragging it into todo.
    const todoBoard = await autoDispatchBoard(serverB, "todo-board");
    const todoCard = await createCard(serverB, todoBoard, { text: "secondary todo card", status: "todo" });

    // A card waiting on a blocker: the blocker reaches done through the real
    // route, which calls onBlockerDone and arms the grace timer.
    const chainBoard = await autoDispatchBoard(serverB, "chain-board");
    const blocker = await createCard(serverB, chainBoard, { text: "blocker card", status: "backlog" });
    const dependent = await createCard(serverB, chainBoard, { text: "dependent card", status: "todo", blockedByTaskId: blocker.id });
    await api(serverB, "PATCH", `/api/boards/${blocker.projectId}/tasks/${blocker.id}`, { status: "done" });
    expect((await readCard(serverB, blocker)).status).toBe("done");

    // A card held for memory, started by hand: the start-anyway route.
    const memoryBoard = await autoDispatchBoard(serverB, "memory-board");
    const held = await createCard(serverB, memoryBoard, { text: "memory held card", status: "todo" });
    withDb(serverB, (db) => db.run("UPDATE tasks SET dispatch_state = 'queued', dispatch_error = 'waiting-memory' WHERE id = ?", [held.id]));
    const manual = await fetch(`${base(serverB)}/api/boards/${held.projectId}/tasks/${held.id}/start-anyway`, { method: "POST" });
    // `start_rejected`, not `not_memory_queued`: the card was a memory waiter, the dispatch ran and claimed nothing.
    expect({ status: manual.status, code: ((await manual.json()) as { code?: string }).code }).toEqual({ status: 409, code: "start_rejected" });

    // A scheduled card already due: the 15 s timer would create its card.
    const cronBoard = await autoDispatchBoard(serverB, "cron-board");
    const schedule = await api<{ id: string }>(serverB, "POST", `/api/boards/${cronBoard}/scheduled-cards`, {
      text: "scheduled card", status: "todo", labels: [], cron: "* * * * *", timeZone: "UTC",
    });
    withDb(serverB, (db) => db.run("UPDATE scheduled_cards SET next_run_at = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), schedule.id]));

    await Bun.sleep(QUIET_WINDOW_MS);

    const view = async (card: TaskView) => {
      const t = await readCard(serverB, card);
      return { claimed: claimed(t), status: t.status, dispatchState: t.dispatchState, dispatchError: t.dispatchError };
    };
    const fired = withDb(serverB, (db) => db.query("SELECT last_run_at FROM scheduled_cards WHERE id = ?").get(schedule.id) as { last_run_at: string | null });
    const summary = {
      todo: (await view(todoCard)).claimed,
      blockerDone: (await view(dependent)).claimed,
      manualStart: (await view(held)).claimed,
      scheduledFired: fired.last_run_at !== null,
    };
    if (Object.values(summary).some(Boolean)) {
      console.error(JSON.stringify({ todo: await view(todoCard), dependent: await view(dependent), held: await view(held), fired }, null, 2));
    }
    expect(summary).toEqual({ todo: false, blockerDone: false, manualStart: false, scheduledFired: false });
    // The memory-held card is still the waiter it was: nothing claimed it and nothing cleared it.
    expect(await view(held)).toMatchObject({ status: "todo", dispatchState: "queued", dispatchError: "waiting-memory" });
  }, 120_000);
});

describe("D, a third server that is not the fleet's primary, cannot steal B's channel from A (MACHINE-01)", () => {
  const serverD = makeServer("d");
  let machineD = "";

  test("D pairs B after A: the channel on B stays A's device, not D's", async () => {
    await boot(serverD);
    const { machines } = await api<{ machines: { id: string; baseUrl: string | null }[] }>(serverD, "GET", "/api/machines");
    machineD = machines.filter((m) => m.baseUrl === null)[0]!.id;

    const before = channelOf(serverB);
    expect(before?.channel_machine_id, "B's channel is still A before D shows up").toBe(machineA);

    const opened = await api<{ pairingId: string }>(serverD, "POST", "/api/machines/pair", { baseUrl: `http://127.0.0.1:${serverB.tunnelHttpPort}` });
    const { requests } = await api<{ requests: { id: string }[] }>(serverB, "GET", "/api/auth/pair/pending");
    expect(requests).toHaveLength(1);
    await api(serverB, "POST", "/api/auth/pair/approve", { requestId: requests[0]!.id });
    const paired = await api<{ state: string }>(serverD, "GET", `/api/machines/pair/${opened.pairingId}`);
    expect(paired.state).toBe("approved");

    expect(channelOf(serverB), "D's pairing left B's channel exactly as it was").toEqual(before);
  }, 60_000);

  test("A restarted at a higher epoch is still adopted by B", async () => {
    await stop(serverA);
    writePrimaryState(serverA, machineA, 8);
    await boot(serverA);
    const until = Date.now() + slackMs(45_000);
    while (Date.now() < until && primaryRow(serverB).epoch !== 8) await Bun.sleep(500);
    expect(primaryRow(serverB), `B adopted A's new epoch\n${logOf(serverB)}`).toMatchObject({ primary_machine_id: machineA, epoch: 8 });
  }, 120_000);

  test("D, declaring a higher epoch on its own authority, is never adopted by B", async () => {
    await stop(serverD);
    // D now believes itself to be a primary at epoch 9 (a split-brain, or just
    // a confused install): its own heartbeat to B will carry that epoch.
    writePrimaryState(serverD, machineD, 9);
    await boot(serverD);
    await Bun.sleep(slackMs(QUIET_WINDOW_MS));
    expect(primaryRow(serverB), `B ignored D, which is not its channel's device\n${logOf(serverB)}`).toMatchObject({ primary_machine_id: machineA, epoch: 8 });
    // A, the real primary, is still accepted on every door.
    for (const [door, call] of Object.entries(doors(serverB))) {
      expect((await call("8")).status, `${door} with A's epoch after D's attempt`).not.toBe(409);
    }
  }, 120_000);
});
