/**
 * THE LOAD SCREEN OF A MACHINE THAT TAKES THE LOAD (`/schermo/<machine>`).
 *
 * The PC's monitor shows the Mac's Topics, full screen: its state and the
 * countdown to sleep, who weighs process by process (MB, CPU), the cards
 * running on it with project and how long, the jobs sent to it and by whom,
 * the pace of each quota. Built from the app's own pieces (the Processes
 * view's gauges and rows, the pace dial of «Account e quote»).
 *
 * Two fakes at the external boundary, nothing inside Topics mocked:
 *  - the hub (helpers/fake-hub.ts), whose PC entry is replaced per scene;
 *  - the PC itself: a second HTTP server that pairs through the REAL
 *    handshake (`POST /api/machines/pair`, then the poll, which writes the
 *    device token) and answers `/api/system/machine-readout` like the PC's
 *    Topics would: its process list, and the sleep keeper's file written
 *    EXACTLY as wf-autosleep writes it (`sospendeAlle` in epoch ms, a number)
 *    and read by the REAL `parseScreenFile`, the PC's own parser.
 * The real :3360, :3333 and PC are never touched; names are placeholders.
 *
 * Scenes at 1920x1080: at rest (the countdown, nothing running), then the
 * same page turning to work by itself (a card on the node, a job sent by the
 * Mac); and at work on the PC's real 3440x1440 monitor, where every list row
 * must end inside its list. Video on: the recording is the proof; the
 * screenshots go to the test's output (`vero-schermo-*.png`) and, with
 * LOAD_SCREEN_SHOTS set, to that folder too.
 *
 * Mutation: with `cardsOn` (lib/loadScreen.ts) ignoring `machineId`, «only the
 * node's own cards» is red (the card of the other board shows up).
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
    { name: working ? "node" : "msedge", count: working ? 6 : 9, memMB: working ? 3480 : 1210, cpuPct: working ? 412.5 : 1.2 },
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
    inside(document.querySelector('[data-testid="load-screen-running-list"]'), ':scope > *', "running");
    for (const id of ["load-screen-weight", "load-screen-running", "load-screen-pace", "load-screen-outcomes"]) {
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
  const tasks: Array<[string, string]> = [];

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    mkdirSync(OTHER_PATH, { recursive: true });
    for (const path of [PROJECT_PATH, OTHER_PATH]) {
      const r = await request.post(`${E2E_BASE}/api/topics`, { data: { name: "Chat", projectPath: path } });
      expect(r.ok(), await r.text()).toBe(true);
    }
    hub = await startFakeHub();
    node = await startFakeNode();
    nodeId = await pairNode(request, node.url);
  });

  test.afterAll(async ({ request }) => {
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

  test("at rest: the countdown from the keeper's own file; then the page turns to work by itself", async ({ page, request }, testInfo) => {
    const now = Date.now();
    node!.working = false;
    hub!.answersOverride = { machines: machines(false, now) };
    await page.goto(`${E2E_BASE}/schermo/${encodeURIComponent(nodeId)}`);
    const screen = page.getByTestId("load-screen");
    await expect(screen).toHaveAttribute("data-state", "countdown", { timeout: 30_000 });
    await expect(page.getByTestId("load-screen-headline")).toHaveText(/Dorme fra 1[34] min/);
    await expect(page.getByTestId("load-screen-name")).toHaveText("PC");
    await expect(page.getByTestId("load-screen-pc-state")).toHaveAttribute("data-state", "acceso");
    await expect(page.getByTestId("load-screen-running-none")).toBeVisible();
    // Who weighs: the PC's own programs, with MB and CPU; a CPU the reader did not measure is a dash.
    const rows = page.getByTestId("machine-process-row");
    await expect(rows.first()).toContainText("msedge");
    await expect(rows.first()).toContainText("1,2 GB");
    await expect(rows.first()).toContainText("9 processi");
    await expect(rows.first()).toHaveAttribute("data-kind", "app");
    // Windows' own programs are the system's, not «app».
    await expect(rows.filter({ hasText: "dwm" })).toHaveAttribute("data-kind", "macos");
    await expect(rows.filter({ hasText: "MsMpEng" }).getByTestId("machine-process-cpu")).toHaveText("-");
    await expect(page.getByTestId("load-screen-subline")).toHaveText(/^alle \d\d:\d\d, dopo 20 min senza lavoro$/);
    // The rows that do not fit join the rest line with the 168 the PC left out: the count adds up.
    const { rows: shown, cut } = await nothingCut(page);
    expect(cut).toEqual([]);
    const hiddenCount = procs(false).slice(shown).reduce((n, p) => n + p.count, 0);
    await expect(page.getByTestId("load-screen-procs-rest")).toContainText(`Altri ${168 + hiddenCount} processi`);
    // The pace row of «Account e quote», dial included.
    await expect(page.getByTestId("load-screen-pace-row").first().getByTestId("account-dial")).toBeVisible();
    await expect(page.getByTestId("load-screen-outcome").first()).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("load-screen-outcome").nth(2)).toContainText("interrotto");
    // Cheap: nothing on the page animates, and the whole page fits the screen.
    const cost = await page.evaluate(() => ({
      animations: document.getAnimations().length,
      scroll: document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight,
    }));
    expect(cost).toEqual({ animations: 0, scroll: false });
    const shot = testInfo.outputPath("vero-schermo-riposo.png");
    await page.screenshot({ path: shot });
    keep(shot, "schermo-riposo.png");

    // ── The PC takes work: a card on the node, one on another machine, a job sent by the Mac.
    await holdDispatchReconcile(request, 180_000);
    tasks.push([PROJECT_ID, await createTask(request, PROJECT_ID, { text: "Rifare la sincronizzazione del calendario", status: "in_progress", machineId: nodeId })]);
    // A card running on another machine is not this screen's.
    tasks.push([OTHER_ID, await createTask(request, OTHER_ID, { text: "Card che gira sul Mac", status: "in_progress" })]);
    node!.working = true;
    hub!.answersOverride = { machines: machines(true, Date.now()) };
    // The page reads again by itself (every 20 s; the Mac keeps a node's answer 15 s): no reload.
    await expect(screen).toHaveAttribute("data-state", "working", { timeout: 60_000 });
    await expect(page.getByTestId("load-screen-headline")).toHaveText("Sta lavorando");
    await expect(page.getByTestId("load-screen-subline")).toHaveText("1 card · 1 lavoro mandato");
    const card = page.getByTestId("load-screen-card");
    await expect(card).toHaveCount(1);
    // The board's own card, compact.
    await expect(card.locator('[data-density="compact"]')).toHaveCount(1);
    await expect(card).toContainText("Rifare la sincronizzazione del calendario");
    await expect(card).toContainText("acme-web");
    await expect(card.getByTestId("load-screen-card-since")).toHaveText(/^da /);
    const job = page.getByTestId("load-screen-job");
    await expect(job).toContainText("i test nel browser");
    await expect(job).toContainText("da Mac");
    await expect(job).toContainText("da 7 min");
    // The running work is its own reason: the keeper's list of reasons is not repeated under it.
    await expect(page.getByTestId("load-screen-why")).toHaveCount(0);
    expect((await nothingCut(page)).cut).toEqual([]);
    await expect(rows.first()).toContainText("node");
    await expect(rows.first().getByTestId("machine-process-cpu")).toHaveText("413%");
    const shot2 = testInfo.outputPath("vero-schermo-lavoro.png");
    await page.screenshot({ path: shot2 });
    keep(shot2, "schermo-lavoro.png");
    expect(node!.reads).toBeGreaterThan(0);
    const video = page.video();
    await page.close();
    // saveAs, not path(): the browser may run on another machine (pw-remote).
    if (video && SHOTS) { mkdirSync(SHOTS, { recursive: true }); await video.saveAs(join(SHOTS, "schermo-lavoro.webm")); }
  });

  test("on the PC's own 3440x1440 monitor at work: every row whole", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 3440, height: 1440 });
    node!.working = true;
    hub!.answersOverride = { machines: machines(true, Date.now()) };
    await page.goto(`${E2E_BASE}/schermo/${encodeURIComponent(nodeId)}`);
    await expect(page.getByTestId("load-screen")).toHaveAttribute("data-state", "working", { timeout: 30_000 });
    await expect(page.getByTestId("load-screen-card")).toHaveCount(1);
    const { rows, cut } = await nothingCut(page);
    expect(cut).toEqual([]);
    expect(rows).toBeGreaterThanOrEqual(8);
    const scroll = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth);
    expect(scroll).toBe(false);
    const shot = testInfo.outputPath("vero-schermo-uw-lavoro.png");
    await page.screenshot({ path: shot });
    keep(shot, "schermo-uw-lavoro.png");
  });
});
