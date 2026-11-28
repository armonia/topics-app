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
 *   7. And the other half of the same defect: a channel frozen at the first
 *      pairing would lock a node to a primary that no longer exists. A pairing
 *      takes the channel over only when it declares an epoch ABOVE the one the
 *      node adopted (no epoch, a lower or an equal one take nothing, and a
 *      lower one is refused at the door), the machine holding the channel keeps
 *      it when it pairs a new device, the primary the node still obeys reclaims
 *      it, a SECONDARY that knows a later epoch declares nothing at pairing,
 *      and D, once chosen primary at a higher epoch with A gone, pairs B, takes
 *      the channel, is adopted, and makes A's epoch stale.
 *   8. A pairing server collects a NODE credential, not an owner's (card
 *      a97724c1): D's cookie, through B's tunnel, is refused commands, topics,
 *      pairing approval, settings and devices, and B's channel does not move;
 *      A's cookie still reaches every route a primary calls on its node and
 *      starts a run there; D creates, reads, bundles and cancels no run, and
 *      touches no normal card; a phone paired on B stays owner; the migration
 *      turns a machine credential from before the channel into a node one with
 *      no user agent involved, and A's card still runs on B after it.
 *
 * @covers MACHINE-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, PROJECT_ROOT, spawnedServerHostEnv, testTmpDir } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { guardAgainstOrphans, registerOrphanRoot, releaseFromOrphanGuard, retireOrphanGuard } from "../helpers/orphan-guard";
import { gitEnv } from "../setup/bun-test-preload";
import { removeFinishedTestTmpDirs } from "../setup/test-tmp-dirs";
import { restrictMachineLikeDevices } from "../../server/lib/node-scope";
import { killProcessTree } from "../../server/lib/process-tree";

const EPOCH_HEADER = "x-topics-primary-epoch";
const MACHINE_HEADER = "x-topics-machine-id";
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
  // `-t`/`.only` still run every `describe` callback during discovery, so this
  // root can exist without the boot that would otherwise register it below.
  registerOrphanRoot(root);
  for (const dir of ["data", "home", "app-data", "topics-home", "public"]) mkdirSync(join(root, dir), { recursive: true });
  return { name, root, port: freePort(), tunnelPort: freePort(), tunnelHttpPort: freePort(), modelProxyPort: freePort(), child: null, boots: 0 };
}

const base = (s: ServerUnderTest) => `http://127.0.0.1:${s.port}`;
const logOf = (s: ServerUnderTest) => {
  try { return readFileSync(join(s.root, `server-${s.boots}.log`), "utf8").slice(-4000); } catch { return ""; }
};

// `freePort()` only probes that a port is free at that instant: with thousands
// of ephemeral ports handed out across the whole CI matrix, another process can
// grab the same number before this child ever binds it, and the real server
// then dies on EADDRINUSE (seen on the tunnel port, run 44993066166). A fresh
// draw of every dynamic port and one retry turns that race into a flake nobody
// chases instead of a red `unit` job.
async function boot(s: ServerUnderTest): Promise<void> {
  try {
    await bootOnce(s);
  } catch (err) {
    const log = logOf(s);
    if (!/EADDRINUSE/.test(log)) throw err;
    s.port = freePort();
    s.tunnelPort = freePort();
    s.tunnelHttpPort = freePort();
    s.modelProxyPort = freePort();
    await bootOnce(s);
  }
}

async function bootOnce(s: ServerUnderTest): Promise<void> {
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
      // The child already has its own isolated dirs; without this a run from a card worktree switches the tunnel ports off.
      TOPICS_ALLOW_WORKTREE_PROD: "1",
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
    // Its own process group: a server that spawns anything of its own (a
    // worktree, a tunnel helper) is reachable through ONE signal to -pid,
    // instead of leaving grandchildren behind when the server itself is
    // SIGTERM'd. `stop()` below relies on this.
    detached: true,
  });
  closeSync(logFd);
  // Registered BEFORE the readiness probe below: a run cut while the server is
  // still booting is exactly how the orphans of card 617a7a68 were born.
  guardAgainstOrphans({ groupLeaderPid: s.child.pid, root: s.root });
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
  const child = s.child;
  s.child = null;
  // `group: true` also signals -pid: the server's own process group, which
  // catches anything it spawned itself, not just the server process.
  await killProcessTree(child.pid, slackMs(5000), { group: true });
  await Promise.race([child.exited, Bun.sleep(slackMs(10_000))]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    child.kill("SIGKILL");
  }
  await child.exited;
  releaseFromOrphanGuard(child.pid);
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

/**
 * A pairing request exactly as a Topics server sends it: the machine id and the
 * epoch travel as headers, so a declaration can be reproduced without booting a
 * whole server for it. The owner of the target approves through the real route,
 * as a person clicking the card would. Returns the status of the request (a
 * replaced primary is refused at the door) and the device id it was given.
 */
async function pairAsMachine(target: ServerUnderTest, declared: { machineId: string; epoch?: number }): Promise<{ status: number; deviceId: string | null }> {
  const tunnel = `http://127.0.0.1:${target.tunnelHttpPort}`;
  const headers: Record<string, string> = { [MACHINE_HEADER]: declared.machineId };
  if (declared.epoch !== undefined) headers[EPOCH_HEADER] = String(declared.epoch);
  const asked = await fetch(`${tunnel}/api/auth/pair/request`, { method: "POST", headers });
  if (!asked.ok) return { status: asked.status, deviceId: null };
  const { requestId } = await asked.json() as { requestId: string };
  const approved = await api<{ deviceId: string }>(target, "POST", "/api/auth/pair/approve", { requestId });
  return { status: asked.status, deviceId: approved.deviceId };
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

/** The cookie a server keeps for one of its nodes, read from the token file its pairing wrote. */
function nodeCookie(s: ServerUnderTest, machineId: string): string {
  for (const file of new Bun.Glob(`**/nodes/${machineId}.token`).scanSync({ cwd: s.root, dot: true })) {
    return `topics_device=${readFileSync(join(s.root, file), "utf8").trim()}`;
  }
  throw new Error(`${s.name} holds no token for node ${machineId}`);
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
  // The preload sweeps roots BEFORE this hook (registered first, at module
  // load): on a server still running here - B never stops mid-test, D is
  // rebooted by the last test and left up - that first sweep races a live
  // server writing into its own root and silently leaves it behind. Now that
  // every server above is confirmed dead, retrying the same sweep removes
  // what the first pass could not.
  removeFinishedTestTmpDirs(null);
  // Every server stopped and its root gone above: the watchdog has nothing
  // left to watch, and its own poll (250 ms) would otherwise race the check
  // that runs right after this process exits.
  retireOrphanGuard();
});

// `afterAll` only runs when this file reaches the end of its own suite. A run
// cut off mid-test is cleaned up by the detached watchdog `bootOnce` registers
// each server with (tests/helpers/orphan-guard.ts), and NOT by a hook of this
// process: measured on bun 1.4.4, SIGINT and SIGTERM sent to `bun test` while a
// test runs kill neither the runner nor the test, and `process.on("exit", ...)`
// does not fire on either; the signal that does end a cut run is SIGKILL, which
// runs no code at all. An earlier version of this file cleaned up from
// `process.on("exit")` and was dead code (card 617a7a68).

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
    withDb(serverB, (db) => db.run("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), schedule.id]));

    await Bun.sleep(QUIET_WINDOW_MS);

    const view = async (card: TaskView) => {
      const t = await readCard(serverB, card);
      return { claimed: claimed(t), status: t.status, dispatchState: t.dispatchState, dispatchError: t.dispatchError };
    };
    const fired = withDb(serverB, (db) => db.query("SELECT COUNT(*) AS runs FROM scheduled_job_runs WHERE job_id = ?").get(schedule.id) as { runs: number });
    const summary = {
      todo: (await view(todoCard)).claimed,
      blockerDone: (await view(dependent)).claimed,
      manualStart: (await view(held)).claimed,
      scheduledFired: fired.runs > 0,
    };
    if (Object.values(summary).some(Boolean)) {
      console.error(JSON.stringify({ todo: await view(todoCard), dependent: await view(dependent), held: await view(held), fired }, null, 2));
    }
    expect(summary).toEqual({ todo: false, blockerDone: false, manualStart: false, scheduledFired: false });
    // The memory-held card is still the waiter it was: nothing claimed it and nothing cleared it.
    expect(await view(held)).toMatchObject({ status: "todo", dispatchState: "queued", dispatchError: "waiting-memory" });
  }, 120_000);

  test("B still works the mirror card its primary sends, and still leaves a normal card of its own board alone", async () => {
    // A board whose repository has an origin: `/api/nodes/runs` finds its project by that remote.
    const name = "mirror-board";
    const dir = join(serverB.root, "projects", name);
    mkdirSync(dir, { recursive: true });
    for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://example.test/acme/mirror-repo.git"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: dir, env: process.env }).exitCode).toBe(0);
    }
    await autoDispatchBoard(serverB, name);
    const run = await api<{ runId: string; projectId: string }>(serverB, "POST", "/api/nodes/runs", {
      originTaskId: "origin-mirror-1", originUrl: "https://example.test/acme/mirror-repo.git", text: "mirror card from the primary",
    });
    // The mirror lands on the board keyed by the repository path: switch dispatch on there, then give the card the todo go-ahead again.
    const board = run.projectId;
    await api(serverB, "PATCH", `/api/boards/${board}/settings`, { autoDispatch: true, dispatchUseWorktree: false });
    const normal = await createCard(serverB, board, { text: "normal card of the secondary board", status: "todo" });
    const mirrorCard = { id: run.runId, projectId: board } as TaskView;
    await api(serverB, "PATCH", `/api/boards/${board}/tasks/${run.runId}`, { status: "backlog" });
    await api(serverB, "PATCH", `/api/boards/${board}/tasks/${run.runId}`, { status: "todo" });
    // The bench has no coding model: a mirror the dispatcher picked up comes back parked, one nobody picked up stays in todo.
    const until = Date.now() + QUIET_WINDOW_MS;
    while (Date.now() < until && !claimed(await readCard(serverB, mirrorCard))) await Bun.sleep(500);
    expect(claimed(await readCard(serverB, mirrorCard)), `the mirror card left todo\n${logOf(serverB)}`).toBe(true);
    expect(claimed(await readCard(serverB, normal)), "the normal card did not").toBe(false);
  }, 120_000);
});

describe("D, a third server that is not the fleet's primary, cannot steal B's channel from A (MACHINE-01)", () => {
  const serverD = makeServer("d");
  let machineD = "";
  /** B's row on D, written by D's pairing. */
  let nodeBOnD = "";

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
    const paired = await api<{ state: string; machine?: { id: string } }>(serverD, "GET", `/api/machines/pair/${opened.pairingId}`);
    expect(paired.state).toBe("approved");
    nodeBOnD = paired.machine!.id;

    expect(channelOf(serverB), "D's pairing left B's channel exactly as it was").toEqual(before);
  }, 60_000);

  /**
   * The credential a server collects by pairing a node is a NODE credential,
   * not an owner's (card a97724c1). With an owner's, D could ask B to run a
   * command through the tunnel, and that command, running on B, is on
   * loopback: the one transport `pair/approve` trusts to hand the channel over.
   */
  test("(a) D's node cookie, through B's tunnel, gets 403 on commands, topics, pairing approval, settings and devices; the channel stays A's", async () => {
    const before = channelOf(serverB);
    const cookie = nodeCookie(serverD, nodeBOnD);
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const asD = (method: string, path: string, body?: unknown) =>
      status(`${tunnel}${path}`, undefined, {
        method,
        headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // The ghost's request, declaring a machine id and an epoch far above B's.
    const ghost = await fetch(`${tunnel}/api/auth/pair/request`, { method: "POST", headers: { [MACHINE_HEADER]: crypto.randomUUID(), [EPOCH_HEADER]: "50" } });
    const { requestId } = await ghost.json() as { requestId: string };

    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/api/sessions/any-session/commands/run", { command: `curl -X POST http://127.0.0.1:${serverB.port}/api/auth/pair/approve` }],
      ["POST", "/api/topics", { name: "from a node credential" }],
      ["POST", "/api/auth/pair/approve", { requestId }],
      ["GET", "/api/auth/pair/pending"],
      ["PATCH", "/api/settings", { theme: "dark" }],
      ["GET", "/api/auth/devices"],
      ["POST", "/api/terminal/sessions", { cwd: "/" }],
    ];
    for (const [method, path, body] of refused) {
      expect(await asD(method, path, body), `${method} ${path} with D's node cookie`).toEqual({ status: 403, code: "node_scope" });
    }
    const session = await (await fetch(`${tunnel}/api/auth/session`, { headers: { cookie } })).json() as { paired: boolean; role: string };
    expect(session, "B tells D what it is").toMatchObject({ paired: true, role: "node" });
    expect(channelOf(serverB), "nothing D tried moved B's channel").toEqual(before);
    expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: machineA, epoch: 2 });
    await api(serverB, "POST", "/api/auth/pair/deny", { requestId });
  }, 60_000);

  test("(b) A's node cookie still reaches every route a primary calls on its node, and A runs a card on B", async () => {
    const cookie = nodeCookie(serverA, nodeBOnA);
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const asA = (method: string, path: string, body?: unknown) =>
      status(`${tunnel}${path}`, "2", {
        method,
        headers: { cookie, "user-agent": "Topics/test (a)", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const session = await (await fetch(`${tunnel}/api/auth/session`, { headers: { cookie } })).json() as { role: string };
    expect(session.role, "the primary's credential is a node credential too").toBe("node");

    for (const path of ["/api/providers/snapshot", "/api/system/machine-metrics", "/api/system/machine-security", "/api/system/machine-readout"]) {
      expect((await asA("GET", path)).status, `GET ${path}`).toBe(200);
    }
    // The heartbeat probe: a run that does not exist, answered by the route and not by the gate.
    expect((await asA("GET", "/api/nodes/runs/__probe__")).code).not.toBe("node_scope");

    // A card the primary sends: a repository on B whose origin matches the card's.
    const origin = "https://example.test/fleet/node-scope.git";
    const repo = join(serverB.root, "projects", "node-scope");
    mkdirSync(repo, { recursive: true });
    for (const args of [["init", "-q"], ["remote", "add", "origin", origin]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnv() }).exitCode).toBe(0);
    }
    await api(serverB, "POST", "/api/projects", { name: "node-scope", path: realpathSync(repo) });
    const created = await fetch(`${tunnel}/api/nodes/runs`, {
      method: "POST",
      headers: { cookie, "user-agent": "Topics/test (a)", "content-type": "application/json", [EPOCH_HEADER]: "2" },
      body: JSON.stringify({ originTaskId: crypto.randomUUID(), text: "A card the primary runs on its node", originUrl: origin }),
    });
    const run = await created.json() as { runId?: string };
    expect(typeof run.runId, `POST /api/nodes/runs answered ${created.status}: ${JSON.stringify(run)}`).toBe("string");
    expect((await asA("GET", `/api/nodes/runs/${run.runId}`)).status, "A reads its run").toBe(200);
    expect((await asA("DELETE", `/api/nodes/runs/${run.runId}`)).code, "A cancels its run").not.toBe("node_scope");
    // And the primary's credential is confined like D's: no command on its node.
    expect(await asA("POST", "/api/sessions/any-session/commands/run", { command: "true" })).toEqual({ status: 403, code: "node_scope" });
  }, 60_000);

  /**
   * A node credential reaches the run routes, but a run is a card that starts
   * in `bypassPermissions`: from D it would be execution again. Only the
   * channel's device creates runs, and reads, bundles and cancels only its own.
   */
  test("(a2) D's node cookie, through B's tunnel, gets 403 on POST/GET/bundle/DELETE runs and on a normal card; A still creates and cancels its own", async () => {
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const as = (cookie: string, ua: string) => (method: string, path: string, body?: unknown) =>
      status(`${tunnel}${path}`, "2", {
        method,
        headers: { cookie, "user-agent": ua, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const asA = as(nodeCookie(serverA, nodeBOnA), "Topics/test (a)");
    const asD = as(nodeCookie(serverD, nodeBOnD), "Topics/test (d)");
    const origin = "https://example.test/fleet/node-scope.git";

    const created = await fetch(`${tunnel}/api/nodes/runs`, {
      method: "POST",
      headers: { cookie: nodeCookie(serverA, nodeBOnA), "user-agent": "Topics/test (a)", "content-type": "application/json", [EPOCH_HEADER]: "2" },
      body: JSON.stringify({ originTaskId: crypto.randomUUID(), text: "A's run D must not touch", originUrl: origin }),
    });
    const run = await created.json() as { runId?: string };
    expect(created.status, JSON.stringify(run)).toBe(201);
    const board = await autoDispatchBoard(serverB, "d-target-board");
    const card = await createCard(serverB, board, { text: "a card of B's own board", status: "backlog" });

    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/api/nodes/runs", { originTaskId: crypto.randomUUID(), text: "D's arbitrary text", originUrl: origin }],
      ["GET", `/api/nodes/runs/${run.runId}`],
      ["GET", `/api/nodes/runs/${run.runId}/bundle`],
      ["DELETE", `/api/nodes/runs/${run.runId}`],
      ["GET", `/api/nodes/runs/${card.id}`],
      ["DELETE", `/api/nodes/runs/${card.id}`],
    ];
    for (const [method, path, body] of refused) {
      expect(await asD(method, path, body), `${method} ${path} with D's node cookie`).toEqual({ status: 403, code: "node_run_scope" });
    }
    expect((await readCard(serverB, card)).status, "B's card is untouched").toBe("backlog");
    // A, the channel, is not refused on its own run, and still cannot reach B's normal card.
    expect((await asA("GET", `/api/nodes/runs/${run.runId}`)).status).toBe(200);
    expect(await asA("DELETE", `/api/nodes/runs/${card.id}`)).toEqual({ status: 403, code: "node_run_scope" });
    expect((await asA("DELETE", `/api/nodes/runs/${run.runId}`)).status).toBe(200);
  }, 60_000);

  test("(c) a phone paired on B stays owner: it creates a topic, reaches commands/run and the device list, and sees the servers as nodes", async () => {
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const phone = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)" };
    const asked = await (await fetch(`${tunnel}/api/auth/pair/request`, { method: "POST", headers: phone })).json() as { requestId: string; claim: string };
    const approved = await api<{ role: string }>(serverB, "POST", "/api/auth/pair/approve", { requestId: asked.requestId });
    expect(approved.role).toBe("owner");
    const collected = await fetch(`${tunnel}/api/auth/pair/status?requestId=${asked.requestId}&claim=${asked.claim}`, { headers: phone });
    const cookie = (collected.headers.get("set-cookie") ?? "").split(";")[0]!;
    const asPhone = (method: string, path: string, body?: unknown) => fetch(`${tunnel}${path}`, {
      method,
      headers: { cookie, ...phone, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect((await (await asPhone("GET", "/api/auth/session")).json() as { role: string }).role).toBe("owner");
    const topic = await asPhone("POST", "/api/topics", { name: "from the phone" });
    expect(topic.status, await topic.clone().text()).toBeLessThan(300);
    // Past the gate: the route itself answers, and an empty command is its 400.
    expect((await asPhone("POST", "/api/sessions/any-session/commands/run", {})).status).toBe(400);
    const devices = await asPhone("GET", "/api/auth/devices");
    expect(devices.status).toBe(200);
    const roles = ((await devices.json()) as { devices: { role: string }[] }).devices.map((d) => d.role);
    expect(roles.filter((r) => r === "node").length, "A's and D's credentials are listed as nodes").toBeGreaterThanOrEqual(2);
    // And a machine takeover is still a local decision, as before.
    const ghost = await fetch(`${tunnel}/api/auth/pair/request`, { method: "POST", headers: { [MACHINE_HEADER]: crypto.randomUUID(), [EPOCH_HEADER]: "50" } });
    const { requestId } = await ghost.json() as { requestId: string };
    const approve = await asPhone("POST", "/api/auth/pair/approve", { requestId });
    expect({ status: approve.status, body: await approve.json() }).toEqual({ status: 403, body: { error: "machine_pairing_requires_local_session" } });
    await api(serverB, "POST", "/api/auth/pair/deny", { requestId });
  }, 60_000);

  test("the migration turns a machine credential paired before the channel existed into a node one, with no user agent, and A's card still runs on B", async () => {
    const cookie = nodeCookie(serverA, nodeBOnA);
    const before = channelOf(serverB)!;
    const deviceId = before.channel_device_id!;
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const roleOf = async () => ((await (await fetch(`${tunnel}/api/auth/session`, { headers: { cookie } })).json()) as { role: string }).role;
    // What a node paired before 18/11 looks like: no channel, A's device with no mark and no
    // trace of a person on it. Whatever name it carries is not read.
    withDb(serverB, (db) => {
      db.run("DELETE FROM node_devices WHERE device_id = ?", [deviceId]);
      db.run("UPDATE primary_state SET channel_device_id = NULL, channel_machine_id = NULL WHERE id = 1");
    });
    expect(await roleOf(), "unmarked, it was an owner").toBe("owner");
    withDb(serverB, (db) => restrictMachineLikeDevices(db));
    // The bare cookie, no Topics user agent: the role comes from the database.
    expect(await roleOf()).toBe("node");
    expect((await status(`${tunnel}/api/topics`, undefined, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status).toBe(403);
    // And the fleet keeps working on the migrated machine: A's card is created on B.
    const created = await fetch(`${tunnel}/api/nodes/runs`, {
      method: "POST",
      headers: { cookie, "user-agent": "Topics/test (a)", "content-type": "application/json", [EPOCH_HEADER]: "2" },
      body: JSON.stringify({ originTaskId: crypto.randomUUID(), text: "A card after the migration", originUrl: "https://example.test/fleet/node-scope.git" }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    withDb(serverB, (db) => db.run("UPDATE primary_state SET channel_device_id = ?, channel_machine_id = ? WHERE id = 1", [before.channel_device_id, before.channel_machine_id]));
  }, 60_000);

  test("an owner credential a Topics server calls the run routes with is narrowed to a node one, never the other way", async () => {
    const cookie = nodeCookie(serverA, nodeBOnA);
    const deviceId = channelOf(serverB)!.channel_device_id!;
    withDb(serverB, (db) => db.run("DELETE FROM node_devices WHERE device_id = ?", [deviceId]));
    const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
    const roleOf = async () => ((await (await fetch(`${tunnel}/api/auth/session`, { headers: { cookie } })).json()) as { role: string }).role;
    expect(await roleOf()).toBe("owner");
    // A's next heartbeat probe, as its node client sends it.
    await fetch(`${tunnel}/api/nodes/runs/__probe__`, { headers: { cookie, "user-agent": "Topics/test (a)" } });
    expect(await roleOf()).toBe("node");
    expect(logOf(serverB)).toContain(`device ${deviceId} called the node routes as a Topics server`);
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

  /**
   * The other half of the same defect, and the one a guard against "last
   * pairing wins" can easily create: if a channel were frozen at the first
   * pairing, a node could NEVER follow a legitimate change of primary. The
   * line is the epoch: a pairing the owner approves takes the channel over
   * only when it declares one above the epoch the node adopted, and only a
   * chosen primary declares an epoch at all.
   */
  describe("the channel follows a new primary, by epoch only", () => {
    /** A machine id nobody runs: what a pairing declares is a declaration, not a proof. */
    const ghost = crypto.randomUUID();

    test("a ghost pairing approved through the tunnel with an owner cookie is refused: the channel stays put (MACHINE-01)", async () => {
      const before = channelOf(serverB);
      expect(before?.channel_machine_id, "B's channel is A's before the ghost shows up").toBe(machineA);

      // An owner device paired through the tunnel: the cookie it collects is
      // exactly what a secondary server, already paired as owner, carries
      // back through the tunnel too — the door this guard closes.
      const tunnel = `http://127.0.0.1:${serverB.tunnelHttpPort}`;
      const asked = await (await fetch(`${tunnel}/api/auth/pair/request`, { method: "POST" })).json() as { requestId: string; claim: string };
      await api(serverB, "POST", "/api/auth/pair/approve", { requestId: asked.requestId });
      const collected = await fetch(`${tunnel}/api/auth/pair/status?requestId=${asked.requestId}&claim=${asked.claim}`);
      const ownerCookie = (collected.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect(ownerCookie, "the device received its owner session").toContain("=");

      // The ghost declares a machine id and an epoch far above B's current one.
      const ghostId = crypto.randomUUID();
      const reqRes = await fetch(`${tunnel}/api/auth/pair/request`, {
        method: "POST",
        headers: { [MACHINE_HEADER]: ghostId, [EPOCH_HEADER]: "50" },
      });
      expect(reqRes.ok).toBe(true);
      const { requestId } = await reqRes.json() as { requestId: string };

      // Approved through the tunnel, with a real owner cookie: refused at the door.
      const approveRes = await fetch(`${tunnel}/api/auth/pair/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ requestId }),
      });
      expect({ status: approveRes.status, body: await approveRes.json() }, "a tunnel call, even with an owner cookie, is not a local session")
        .toEqual({ status: 403, body: { error: "machine_pairing_requires_local_session" } });
      expect(channelOf(serverB), "the ghost's approval through the tunnel changed nothing").toEqual(before);
      expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: machineA, epoch: 8 });
    }, 60_000);

    test("no epoch, a lower one or an equal one takes nothing; a replaced primary cannot even ask", async () => {
      const before = channelOf(serverB);
      expect(before?.channel_machine_id, "B's channel is A's before anybody else asks").toBe(machineA);

      const lower = await pairAsMachine(serverB, { machineId: ghost, epoch: 7 });
      expect(lower, "epoch 7 is below B's 8: refused at the door, never approved").toEqual({ status: 409, deviceId: null });

      for (const epoch of [undefined, 8]) {
        const asked = await pairAsMachine(serverB, { machineId: ghost, epoch });
        expect(asked.deviceId, `the pairing declaring epoch ${epoch ?? "none"} was approved`).not.toBeNull();
        expect(channelOf(serverB), `epoch ${epoch ?? "none"} left B's channel alone`).toEqual(before);
      }
      expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: machineA, epoch: 8 });
    }, 60_000);

    test("an epoch above B's takes the channel, and the machine holding it keeps it when it pairs again", async () => {
      const taken = await pairAsMachine(serverB, { machineId: ghost, epoch: 9 });
      expect(channelOf(serverB), "epoch 9 is above B's 8: the channel changed hands").toEqual({ channel_device_id: taken.deviceId, channel_machine_id: ghost });
      expect(primaryRow(serverB), "a pairing records a channel, it never moves the epoch by itself").toMatchObject({ primary_machine_id: machineA, epoch: 8 });

      // The same machine pairs a second device (its token was revoked, say) and
      // declares nothing above B's epoch: it keeps the channel it already holds.
      const again = await pairAsMachine(serverB, { machineId: ghost, epoch: 8 });
      expect(channelOf(serverB), "the machine that holds the channel keeps it").toEqual({ channel_device_id: again.deviceId, channel_machine_id: ghost });
    }, 60_000);

    test("the primary B still obeys reclaims its channel without a higher epoch", async () => {
      const reclaimed = await pairAsMachine(serverB, { machineId: machineA, epoch: 8 });
      expect(channelOf(serverB), "A is the primary B recognizes: its pairing restores its own channel").toEqual({ channel_device_id: reclaimed.deviceId, channel_machine_id: machineA });
      expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: machineA, epoch: 8 });
    }, 60_000);

    test("a secondary holding a higher epoch pairs B and declares nothing", async () => {
      const before = channelOf(serverB);
      await stop(serverD);
      // D is a SECONDARY that knows a later epoch: it believes A is the primary
      // at 10. It must not declare itself at pairing, so its machine id and that
      // epoch never reach B.
      writePrimaryState(serverD, machineA, 10);
      await boot(serverD);
      const opened = await api<{ pairingId: string }>(serverD, "POST", "/api/machines/pair", { baseUrl: `http://127.0.0.1:${serverB.tunnelHttpPort}` });
      const { requests } = await api<{ requests: { id: string }[] }>(serverB, "GET", "/api/auth/pair/pending");
      expect(requests).toHaveLength(1);
      await api(serverB, "POST", "/api/auth/pair/approve", { requestId: requests[0]!.id });
      expect((await api<{ state: string }>(serverD, "GET", `/api/machines/pair/${opened.pairingId}`)).state).toBe("approved");
      expect(channelOf(serverB), "a secondary's pairing left B's channel exactly as it was").toEqual(before);
      expect(primaryRow(serverB)).toMatchObject({ primary_machine_id: machineA, epoch: 8 });
    }, 120_000);

    test("A is gone, D is chosen primary at epoch 11: it pairs B, takes the channel and is adopted, and A's epoch is now stale", async () => {
      await stop(serverA);
      await stop(serverD);
      writePrimaryState(serverD, machineD, 11);
      await boot(serverD);

      const opened = await api<{ pairingId: string }>(serverD, "POST", "/api/machines/pair", { baseUrl: `http://127.0.0.1:${serverB.tunnelHttpPort}` });
      const { requests } = await api<{ requests: { id: string }[] }>(serverB, "GET", "/api/auth/pair/pending");
      expect(requests).toHaveLength(1);
      const approved = await api<{ deviceId: string }>(serverB, "POST", "/api/auth/pair/approve", { requestId: requests[0]!.id });
      expect((await api<{ state: string }>(serverD, "GET", `/api/machines/pair/${opened.pairingId}`)).state).toBe("approved");
      expect(channelOf(serverB), "the new primary declared epoch 11 and took the channel").toEqual({ channel_device_id: approved.deviceId, channel_machine_id: machineD });

      // D's heartbeat now reaches B through the channel it just took.
      const until = Date.now() + slackMs(45_000);
      while (Date.now() < until && primaryRow(serverB).epoch !== 11) await Bun.sleep(500);
      expect(primaryRow(serverB), `B adopted the new primary\n${logOf(serverB)}`).toMatchObject({ primary_machine_id: machineD, epoch: 11 });
      expect(JSON.parse(readFileSync(join(serverB.root, "app-data", "primary-state.json"), "utf8"))).toMatchObject({ primaryMachineId: machineD, epoch: 11 });

      // A, were it to come back at 8, is now the replaced primary on every door.
      for (const [door, call] of Object.entries(doors(serverB))) {
        expect(await call("8"), `${door} with A's old epoch`).toEqual({ status: 409, code: STALE_CODE });
      }
    }, 180_000);
  });
});
