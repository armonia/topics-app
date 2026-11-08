/**
 * THE LOAD SCREEN OF A MACHINE THAT TAKES THE LOAD (`/schermo/<machine>`).
 *
 * The PC's monitor shows Topics, full screen, and the subject is the SESSIONS:
 * every card at work with its model, tokens, tokens per second, a clock that
 * runs, and the CPU and memory of everything Topics launched for it, a shared
 * process split between the sessions that use it; the work the Mac sent to the
 * PC under the session that sent it. The PC's own processes are a smaller
 * section on the side; the sleep countdown and the keeper's file are the hero.
 * Built from the app's own pieces (the app's mark and name, the Processes
 * view's gauges and rows, the board's state icon).
 *
 * Two fakes at the external boundary, nothing inside Topics mocked:
 *  - the hub (helpers/fake-hub.ts), whose PC entry is replaced per scene;
 *  - the PC itself: a second HTTP server that pairs through the REAL
 *    handshake (`POST /api/machines/pair`, then the poll, which writes the
 *    device token) and answers `/api/system/machine-readout` like the PC's
 *    Topics would: its process list, and the sleep keeper's file written
 *    EXACTLY as wf-autosleep writes it (`sospendeAlle` in epoch ms, a number)
 *    and read by the REAL `parseScreenFile`, the PC's own parser.
 * The sessions are real: cards in progress bound to chats, tokens in the native
 * registry, and real child processes of the test server registered as their
 * CLIs (helpers/session-seed.ts). The real :3360, :3333 and PC are never
 * touched; names are placeholders.
 *
 * Scenes at 1920x1080: at rest (the countdown, no session), then the same page
 * turning to work by itself (two sessions, a job sent by the Mac); and at work
 * on the PC's real 3440x1440 monitor, where every list row must end inside its
 * list. Video on: the recording is the proof; the screenshots go to the test's
 * output (`vero-schermo-*.png`) and, with LOAD_SCREEN_SHOTS set, to that folder
 * too, under the names the review asks for.
 *
 * Mutation: with the output rate (`lib/session-rate.ts`) always null, «tokens
 * per second move» is red; with the attribution billing the shared server to no
 * one, «the shared slice is named» is red.
 *
 * @covers HUBBR-21
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { holdDispatchReconcile } from "./helpers/api-fixtures";
import { feedRounds, seedRunningCard, type RunningCard } from "./helpers/session-seed";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";
import { projectIdForPath } from "../../shared/board";
import { parseScreenFile } from "../../server/lib/machine-readout";

hermetic(test);
test.use({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", locale: "it-IT", video: { mode: "on", size: { width: 1920, height: 1080 } } });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const MIN = 60_000;
const STAMP = Date.now();
const PROJECT_PATH = join(realpathSync("/tmp"), `e2e-load-screen-${STAMP}`, "acme-web");
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const OTHER_PATH = join(realpathSync("/tmp"), `e2e-load-screen-${STAMP}`, "studio-x");
const OTHER_ID = projectIdForPath(OTHER_PATH);
/** The device token the fake PC hands out at pairing, made per run. */
const DEVICE_COOKIE = `e2e${randomBytes(16).toString("hex")}`;
const SHOTS = process.env.LOAD_SCREEN_SHOTS ?? "";

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The keeper's screen file, byte for byte in its shape: UTF-8 without BOM,
 * one `window.STATO = <ConvertTo-Json>;` line; `sospendeAlle` is `Epoch-Ms`, allow-italian: the keeper's wire format
 * a NUMBER, null while something keeps the PC awake.
 */
function keeperScreenFile(working: boolean, now: number): string {
  const screenFile = {
    versione: 1,
    ora: iso(now),
    sogliaMinuti: 20,
    sospendeAlle: working ? null : now + 13 * MIN + 20_000,
    motivi: working ? ["Il Mac è collegato al PC", "Una card di Topics sta lavorando su questo PC"] : [],
    lavori: working ? [{ progetto: "studio-x", cosa: "i test nel browser", chi: "Mac", da: iso(now - 7 * MIN), secondi: 420 }] : [],
    esiti: [
      { progetto: "acme-web", cosa: "test", esito: "fallito", secondi: 86, fine: iso(now - 9 * MIN) },
      { progetto: "studio-x", cosa: "preparazione delle dipendenze e test", esito: "ok", secondi: 78, fine: iso(now - 11 * MIN) },
      { progetto: "studio-x", cosa: "build", esito: "interrotto", secondi: 109, fine: iso(now - 14 * MIN) },
    ],
  };
  return `window.STATO = ${JSON.stringify(screenFile, null, 4)};\n`;
}

/** The PC's process list, as its Topics groups it: heaviest first, MB and % of one core. */
function procs(working: boolean) {
  return [
    // At work the heaviest program is the Mac's test run: flagged as sent work, as the PC's lister flags it.
    { name: working ? "node" : "msedge", count: working ? 6 : 9, memMB: working ? 3480 : 1210, cpuPct: working ? 412.5 : 1.2, ...(working ? { job: true } : {}) },
    { name: working ? "msedge" : "explorer", count: working ? 9 : 1, memMB: working ? 1210 : 190, cpuPct: working ? 3.4 : 0.4 },
    { name: working ? "chrome-headless-shell" : "Tailscale", count: working ? 4 : 2, memMB: working ? 960 : 120, cpuPct: working ? 88 : 0.2 },
    { name: "bun", count: 1, memMB: 410, cpuPct: working ? 22 : 0.3 },
    { name: "Code", count: 5, memMB: 380, cpuPct: 0.6 },
    { name: "sshd", count: 2, memMB: 14, cpuPct: working ? 1.1 : 0 },
    { name: "dwm", count: 1, memMB: 96, cpuPct: 1.8 },
    { name: "MsMpEng", count: 1, memMB: 240, cpuPct: null },
    { name: "System", count: 1, memMB: 8, cpuPct: null },
  ];
}

function readout(working: boolean, now: number) {
  return {
    machine: { id: null, name: "PC", local: true },
    error: null,
    readout: {
      at: now, platform: "win32", cores: 16, memTotalMB: 32_768, memMetric: "working-set", total: working ? 214 : 187,
      procs: procs(working), rest: { count: working ? 184 : 168, memMB: working ? 2100 : 1900 },
      // The PC's own parser on the keeper's own file.
      screen: parseScreenFile(keeperScreenFile(working, now)),
    },
  };
}

/** The hub's view of the PC for the scene: the gauges and the hub's own state word. */
function machines(working: boolean, now: number) {
  const history = (base: number) => Array.from({ length: 48 }, (_, i) => ({ t: Math.round((now - (48 - i) * 30 * MIN) / 1000), v: base + ((i * 7) % 23) }));
  return [
    { id: "local", name: "Mac", local: true, state: "tranquillo", level: 0, caption: "12 core · ultime 24 h", lines: [], metrics: [{ key: "cpu", name: "CPU", pct: 31, level: 0, history: [] }], procs: [], offload: 0, load: null },
    {
      id: "pc", name: "PC", local: false, state: working ? "lavora" : "acceso", level: 0, caption: "dorme dopo 20 min senza lavoro",
      lines: working ? ["I test nel browser di studio-x per un terminale, da 7 minuti"] : [],
      metrics: [
        { key: "cpu", name: "CPU", pct: working ? 46 : 3, level: 0, limit: 85, note: working ? "adesso · picco 24 h 89%" : "adesso · picco 24 h 61%", history: history(working ? 30 : 5) },
        { key: "mem", name: "Memoria", pct: working ? 71 : 38, level: 0, limit: 80, note: "adesso", history: history(35) },
        { key: "gpu", name: "GPU", pct: working ? 4 : 1, level: 0, limit: 80, note: "adesso", history: history(1) },
        { key: "disk", name: "Disco", pct: 64, level: 0, limit: 85, note: "340 GB liberi", history: [] },
      ],
      procs: working ? [{ name: "node", cores: 4.1 }] : [], offload: working ? 1 : 0, load: null,
    },
  ];
}

interface FakeNode { url: string; working: boolean; reads: number; close: () => Promise<void> }

/** The PC's Topics, as far as the screen and the pairing need it. */
async function startFakeNode(): Promise<FakeNode> {
  const node: FakeNode = { url: "", working: false, reads: 0, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/api/auth/pair/request") {
      return send(200, { requestId: "req-1", claim: "claim-1", code: "123456", name: "PC", expiresInMs: 60_000 });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/pair/status") {
      return send(200, { state: "approved", name: "PC" }, { "Set-Cookie": `topics_device=${DEVICE_COOKIE}; Path=/; HttpOnly` });
    }
    if (req.method === "GET" && url.pathname === "/api/system/machine-readout") {
      // The Mac must present the device token it was given, as the cookie.
      if (!(req.headers.cookie ?? "").includes(`topics_device=${DEVICE_COOKIE}`)) return send(401, { error: "unauthorized" });
      node.reads += 1;
      return send(200, readout(node.working, Date.now()));
    }
    send(404, { error: "not in the fake node" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  node.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  node.close = () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return node;
}

async function pairNode(request: APIRequestContext, baseUrl: string): Promise<string> {
  const opened = await request.post(`${E2E_BASE}/api/machines/pair`, { data: { baseUrl } });
  expect(opened.ok(), await opened.text()).toBe(true);
  const { pairingId } = (await opened.json()) as { pairingId: string };
  const done = await request.get(`${E2E_BASE}/api/machines/pair/${pairingId}`);
  const body = (await done.json()) as { state: string; machine?: { id: string } };
  expect(body.state).toBe("approved");
  return body.machine!.id;
}

async function createTask(request: APIRequestContext, boardId: string, data: Record<string, unknown>): Promise<string> {
  const res = await request.post(`${E2E_BASE}/api/boards/${boardId}/tasks`, { data });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

function keep(path: string, name: string): void {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, name));
}

/** Every list row ends inside its list, and every section inside the screen: nothing is cut in half. */
async function nothingCut(page: import("@playwright/test").Page): Promise<{ rows: number; cut: string[] }> {
  return page.evaluate(() => {
    const cut: string[] = [];
    const inside = (list: Element | null, sel: string, name: string) => {
      if (!list) return 0;
      const box = list.getBoundingClientRect();
      const kids = Array.from(list.querySelectorAll(sel));
      kids.forEach((k, i) => { if (k.getBoundingClientRect().bottom > box.bottom + 0.5) cut.push(`${name}[${i}]`); });
      return kids.length;
    };
    const rows = inside(document.querySelector('[data-testid="load-screen-procs"]'), '[data-testid="machine-process-row"]', "proc");
    inside(document.querySelector('[data-testid="load-screen-sessions-list"]'), '[data-testid="session-row"]', "session");
    for (const id of ["load-screen-weight", "load-screen-sessions", "load-screen-outcomes"]) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el && el.getBoundingClientRect().bottom > window.innerHeight + 0.5) cut.push(id);
    }
    return { rows, cut };
  });
}

test.describe("the load screen of the PC", () => {
  test.beforeEach(() => { test.info().annotations.push({ type: "spec", description: "HUBBR-21" }); });
  let hub: FakeHub | null = null;
  let node: FakeNode | null = null;
  let nodeId = "";
  const topicIds: Record<string, string> = {};
  const tasks: Array<[string, string]> = [];
  const cards: RunningCard[] = [];

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    mkdirSync(OTHER_PATH, { recursive: true });
    for (const [name, path] of [["acme-web", PROJECT_PATH], ["studio-x", OTHER_PATH]] as const) {
      const r = await request.post(`${E2E_BASE}/api/topics`, { data: { name: "Chat", projectPath: path } });
      expect(r.ok(), await r.text()).toBe(true);
      topicIds[name] = ((await r.json()) as { id: string }).id;
    }
    hub = await startFakeHub();
    node = await startFakeNode();
    nodeId = await pairNode(request, node.url);
  });

  test.afterAll(async ({ request }) => {
    for (const c of cards) await c.stop();
    // A deleted card is archived, not gone, and still names its machine: unhook it first, or the machine cannot be removed.
    for (const [board, id] of tasks) {
      await request.patch(`${E2E_BASE}/api/boards/${board}/tasks/${id}`, { data: { machineId: null } }).catch(() => {});
      await request.delete(`${E2E_BASE}/api/boards/${board}/tasks/${id}`).catch(() => {});
    }
    if (nodeId) {
      const gone = await request.delete(`${E2E_BASE}/api/machines/${nodeId}`);
      expect(gone.ok(), await gone.text()).toBe(true);
    }
    await node?.close();
    await hub?.close();
  });

  test("at rest it is Topics with the countdown; then the sessions arrive by themselves and their numbers move", async ({ page, request }, testInfo) => {
    const now = Date.now();
    node!.working = false;
    hub!.answersOverride = { machines: machines(false, now) };
    await page.goto(`${E2E_BASE}/schermo/${encodeURIComponent(nodeId)}`);
    const screen = page.getByTestId("load-screen");
    await expect(screen).toHaveAttribute("data-state", "countdown", { timeout: 30_000 });
    // It says it is Topics: the app's mark and its name, the same icon the pairing screen shows.
    await expect(page.getByTestId("load-screen-brand")).toHaveText("Topics");
    await expect(page.getByTestId("load-screen-logo")).toHaveAttribute("src", "/icons/icon-192.png");
    await expect(page.getByTestId("load-screen-name")).toHaveText("PC");
    await expect(page.getByTestId("load-screen-headline")).toHaveText(/Dorme fra 1[34] min/);
    await expect(page.getByTestId("load-screen-pc-state")).toHaveAttribute("data-state", "acceso");
    await expect(page.getByTestId("load-screen-sessions-none")).toBeVisible();
    // The quotas' pace is gone from this screen, and the machine's processes are the side section, not the subject.
    await expect(page.getByTestId("load-screen-pace")).toHaveCount(0);
    await expect(page.getByTestId("account-dial")).toHaveCount(0);
    const rows = page.getByTestId("machine-process-row");
    await expect(rows.first()).toContainText("msedge");
    await expect(rows.first()).toContainText("1,2 GB");
    await expect(page.getByTestId("load-screen-subline")).toHaveText(/^alle \d\d:\d\d, dopo 20 min senza lavoro$/);
    expect((await nothingCut(page)).cut).toEqual([]);
    await expect(page.getByTestId("load-screen-outcome").first()).toHaveAttribute("data-ok", "false");
    // Cheap: nothing on the page animates, and the whole page fits the screen.
    const cost = await page.evaluate(() => ({
      animations: document.getAnimations().length,
      scroll: document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight,
    }));
    expect(cost).toEqual({ animations: 0, scroll: false });
    const shot = testInfo.outputPath("vero-schermo-riposo.png");
    await page.screenshot({ path: shot });
    keep(shot, "schermo-riposo.png");

    // ── Two cards take the machine: real sessions, with tokens, a model and a process of their own each.
    await holdDispatchReconcile(request, 240_000);
    const a = await seedRunningCard(request, { boardId: PROJECT_ID, topicId: topicIds["acme-web"], text: "Rifare la sincronizzazione del calendario", model: "claude-opus-5", holdMB: 640, burnPct: 30, input: 38_000, output: 12_400, cacheRead: 410_000 });
    const b = await seedRunningCard(request, { boardId: OTHER_ID, topicId: topicIds["studio-x"], text: "Migrare le notifiche push", model: "claude-sonnet-5", holdMB: 310, burnPct: 12, input: 9_000, output: 3_100, cacheRead: 88_000 });
    cards.push(a, b);
    // Two cards run on the Mac and nothing was sent to the PC: the PC's own countdown stays, its header does not borrow the Mac's sessions.
    await expect(page.getByTestId("session-row")).toHaveCount(2, { timeout: 30_000 });
    await expect(screen).toHaveAttribute("data-state", "countdown");
    await expect(page.getByTestId("load-screen-headline")).toHaveText(/Dorme fra/);
    // A card that runs on the PC itself: nothing of it is measured on the Mac, and the row says where it is.
    tasks.push([OTHER_ID, await createTask(request, OTHER_ID, { text: "Card che gira sul PC", status: "in_progress", machineId: nodeId })]);
    const stopFeeding = feedRounds([{ card: a, perRound: 140 }, { card: b, perRound: 45 }], 2_000);
    try {
      node!.working = true;
      hub!.answersOverride = { machines: machines(true, Date.now()) };
      await expect(screen).toHaveAttribute("data-state", "working", { timeout: 60_000 });
      await expect(page.getByTestId("load-screen-headline")).toHaveText("Sta lavorando");
      // The header counts the sessions on the PC (the one that runs there and the one that sent work to it) and the job, from the sessions' own reading.
      await expect(page.getByTestId("load-screen-subline")).toHaveText("2 sessioni · 1 lavoro mandato", { timeout: 40_000 });
      // The job is placed inside a session, so it is not listed a second time as sent work.
      await expect(page.getByTestId("load-screen-sent")).toHaveCount(0);
      const sessions = page.getByTestId("session-row");
      await expect(sessions).toHaveCount(3, { timeout: 30_000 });
      const rowA = sessions.filter({ hasText: "Rifare la sincronizzazione del calendario" });
      const rowB = sessions.filter({ hasText: "Migrare le notifiche push" });
      // Title, project and the model by its name (not its id), never a bare id.
      await expect(rowA.getByTestId("session-detail")).toHaveText("acme-web · Opus 5");
      await expect(rowB.getByTestId("session-detail")).toHaveText("studio-x · Sonnet 5");
      // The tokens of the session: the total (input + output + cache written) with the split under it.
      await expect(rowA.getByTestId("session-tokens-value")).toHaveText(/^\d+(\.\d)?k$/);
      await expect(rowA.getByTestId("session-tokens")).toContainText("↓38.0k ↑");
      // CPU and memory of everything it launched, and the part shared with the other session named.
      await expect(rowA.getByTestId("session-memory-value")).not.toHaveText("-");
      await expect(rowA.getByTestId("session-memory")).toContainText("condivisi");
      await expect(rowA.getByTestId("session-memory")).toContainText("1/");
      // The sent work is billed to the session of its project, as «from the Mac».
      await expect(rowB.getByTestId("session-remote")).toContainText("Su PC · i test nel browser");
      // A card on the PC is listed, with nothing measured here and its machine named.
      const onPc = sessions.filter({ hasText: "Card che gira sul PC" });
      await expect(onPc.getByTestId("session-memory-value")).toHaveText("-");
      await expect(onPc.getByTestId("session-memory")).toContainText("su PC");
      // The clock runs between two reads: two readings a second and a half apart differ.
      const clock1 = await rowA.getByTestId("session-clock").textContent();
      await expect.poll(async () => rowA.getByTestId("session-clock").textContent(), { timeout: 10_000 }).not.toBe(clock1);
      // Tokens per second: measured from the growth of the output counter, never invented. A session fed
      // 140 tokens every 2 s reads near 70/s once the window has two reads; the slower one reads less.
      const outputRateOf = async (row: typeof rowA) => {
        const v = (await row.getByTestId("session-tps-value").textContent())?.replace(",", ".") ?? "-";
        return v === "-" ? 0 : Number(v);
      };
      await expect.poll(async () => Math.min(await outputRateOf(rowA), await outputRateOf(rowB)), { timeout: 60_000, message: "tokens per second never appeared" }).toBeGreaterThan(5);
      expect(await outputRateOf(rowA)).toBeGreaterThan(await outputRateOf(rowB));
      // The rule is printed once, under the list.
      await expect(page.getByTestId("consumption-notes")).toContainText("diviso in parti uguali");
      expect((await nothingCut(page)).cut).toEqual([]);
      await expect(rows.first()).toContainText("node");
      await expect(rows.first()).toContainText("dal Mac");
      await expect(rows.first().getByTestId("machine-process-cpu")).toHaveText("413%");
      // A moment more, so the recording shows the clocks and the speeds moving.
      const seconds = (t: string | null) => (t ?? "0:00").split(":").map(Number).reduce((n, x) => n * 60 + x, 0);
      const c0 = seconds(await rowA.getByTestId("session-clock").textContent());
      await expect.poll(async () => seconds(await rowA.getByTestId("session-clock").textContent()) - c0, { timeout: 20_000 }).toBeGreaterThanOrEqual(6);
      const shot2 = testInfo.outputPath("vero-schermo-sessioni.png");
      await page.screenshot({ path: shot2 });
      keep(shot2, "sessioni-schermo.png");
    } finally {
      stopFeeding();
    }
    const video = page.video();
    await page.close();
    // saveAs, not path(): the browser may run on another machine (pw-remote).
    if (video && SHOTS) { mkdirSync(SHOTS, { recursive: true }); await video.saveAs(join(SHOTS, "sessioni-schermo.webm")); }
  });

  test("on the PC's own 3440x1440 monitor at work: every row whole", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 3440, height: 1440 });
    node!.working = true;
    hub!.answersOverride = { machines: machines(true, Date.now()) };
    await page.goto(`${E2E_BASE}/schermo/${encodeURIComponent(nodeId)}`);
    await expect(page.getByTestId("load-screen")).toHaveAttribute("data-state", "working", { timeout: 30_000 });
    await expect(page.getByTestId("session-row").first()).toBeVisible({ timeout: 30_000 });
    const { rows, cut } = await nothingCut(page);
    expect(cut).toEqual([]);
    // The machine's weight is the side section now: whole rows only, as many as the column holds.
    expect(rows).toBeGreaterThanOrEqual(2);
    const scroll = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth);
    expect(scroll).toBe(false);
    const shot = testInfo.outputPath("vero-schermo-uw-sessioni.png");
    await page.screenshot({ path: shot });
    keep(shot, "schermo-uw-sessioni.png");
  });
});
