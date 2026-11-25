/**
 * worktrees-settings.spec.ts: the Worktrees form of the settings.
 *
 * The form opens beside the thing it configures, like the calendar and the
 * tools (the palette opens it too). Three things are proved, filmed:
 *   1. a root typed in the form is validated by the server and kept: a relative
 *      path is refused with a line in the form, an absolute one is saved and is
 *      still there after a reload;
 *   2. every other dial shows its default untouched, and a changed one persists;
 *   3. the cleanup preview reads the SAVED root: a folder planted in it that no
 *      row and no git knows is listed as a ghost, with its class and what the
 *      next pass would do, and the preview writes nothing (the folder is still
 *      there afterwards). With no Topics marker the cleanup never moves it, so
 *      the line offers to move it to quarantine by hand, and back.
 *
 * The root cannot be in a temp area (the server refuses it), so it lives in a
 * folder of the machine's home that the spec makes and removes. It already holds
 * the planted ghost, and the server refuses a non-empty root that does not carry
 * Topics' sentinel: the spec writes the sentinel, as Topics' first create would.
 *
 * The cross-machine and cross-harness half (second describe, same form):
 *   4. one line per machine (WORKTREE-STD-11): this one, a node that reports its
 *      worktrees, a node built before the protocol that says so instead of a number;
 *   5. a worktree made by the Claude Code hook script (WORKTREE-STD-13) and one made by
 *      `topics-worktree add` (WORKTREE-STD-14) are registered at once: the cleanup preview
 *      lists them as Topics' own, not as folders without a row waiting for a pass.
 *
 * @covers WORKTREE-STD-01, WORKTREE-STD-03, WORKTREE-STD-11, WORKTREE-STD-13, WORKTREE-STD-14, WORKTREE-STD-15
 */
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { canonicalTmpDir, initGitRepo, removeTmpDir } from "./helpers/file-project";
import { openHomePanel } from "./helpers/user-menu";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { writeRootSentinel } from "../../server/services/worktree-root-ledger";
import { videoAt } from "./video-evidence";

const test = base;
hermetic(test);
test.use({ video: videoAt("on", { width: 1360, height: 860 }), viewport: { width: 1360, height: 860 } });

const STAMP = Date.now();
const ROOT = join(homedir(), `.topics-e2e-worktree-root-${STAMP}`);
const GHOST = join(ROOT, `e2e-ghost-slug`, `ghost-folder-${STAMP}`);

async function openForm(page: Page) {
  await goToApp(page);
  const panel = await openHomePanel(page, "worktrees");
  await expect(panel.getByTestId("worktrees-root")).toBeVisible({ timeout: 15_000 });
  return panel;
}

test.describe("Impostazioni dei worktree", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(() => {
    mkdirSync(GHOST, { recursive: true });
    writeRootSentinel(ROOT);
  });

  test.afterAll(async ({ request }) => {
    // The setting lives in the test server's database: put it back to «not set».
    await request.put(`${E2E_BASE}/api/app-settings`, { data: { worktreeRoot: null, worktreeMaxPerProject: null } }).catch(() => {});
    removeTmpDir(ROOT);
  });

  test("WORKTREE-STD-01: la radice si salva, una radice sbagliata è rifiutata e resta dopo un ricarico", async ({ page }, testInfo) => {
    const panel = await openForm(page);
    const input = panel.getByTestId("worktrees-root");
    await expect(input).toHaveValue("");
    await expect(panel.getByTestId("worktrees-root-save")).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("1-form-vuoto.png") });

    // A relative path is refused, and the form says so instead of fixing it quietly.
    await input.fill("cartella/relativa");
    await panel.getByTestId("worktrees-root-save").click();
    await expect(panel.getByTestId("worktrees-error")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("2-radice-rifiutata.png") });

    // So is a temp area.
    await input.fill("/tmp/worktrees");
    await panel.getByTestId("worktrees-root-save").click();
    await expect(panel.getByTestId("worktrees-error")).toBeVisible();

    await input.fill(ROOT);
    const saved = page.waitForResponse((r) => r.url().includes("/api/app-settings") && r.request().method() === "PUT" && r.ok());
    await panel.getByTestId("worktrees-root-save").click();
    await saved;
    await expect(panel.getByTestId("worktrees-error")).toHaveCount(0);
    await expect(panel.getByTestId("worktrees-root-reset")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("3-radice-salvata.png") });

    // The dials ship with a default that works untouched; one changed stays changed.
    const maxDial = panel.getByRole("combobox", { name: "Worktree tenute per progetto" });
    await expect(maxDial).toContainText("20 worktree");
    await maxDial.click();
    const written = page.waitForResponse((r) => r.url().includes("/api/app-settings") && r.request().method() === "PUT" && r.ok());
    await page.getByRole("option", { name: "40 worktree", exact: true }).click();
    await written;
    await expect(maxDial).toContainText("40 worktree");

    await page.reload();
    const again = await openHomePanel(page, "worktrees");
    await expect(again.getByTestId("worktrees-root")).toHaveValue(ROOT, { timeout: 15_000 });
    await expect(again.getByRole("combobox", { name: "Worktree tenute per progetto" })).toContainText("40 worktree");
  });

  test("WORKTREE-STD-03: l'anteprima della pulizia elenca la cartella fantasma con la sua classe e non scrive nulla", async ({ page, request }, testInfo) => {
    const put = await request.put(`${E2E_BASE}/api/app-settings`, { data: { worktreeRoot: ROOT } });
    expect(put.ok()).toBe(true);
    const panel = await openForm(page);
    await expect(panel.getByTestId("worktrees-root")).toHaveValue(ROOT, { timeout: 15_000 });

    // One ghost is planted, so the summary counts one folder, in the singular form.
    await expect(panel.getByTestId("worktrees-preview-summary")).toContainText("1 cartella ·", { timeout: 15_000 });
    await panel.getByTestId("worktrees-preview-open").click();
    const list = panel.getByTestId("worktrees-preview-list");
    await expect(list).toBeVisible({ timeout: 20_000 });
    const line = list.locator('[data-testid="worktrees-preview-line"][data-class="ghost"]').filter({ hasText: `ghost-folder-${STAMP}` });
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("fantasma");
    await line.scrollIntoViewIfNeeded();
    await expect(line).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("4-anteprima-fantasma.png") });

    // A preview is a read: the folder is where it was, and the server reports the same plan again.
    expect(existsSync(GHOST)).toBe(true);
    await panel.getByTestId("worktrees-preview-open").click();
    await expect(line).toHaveCount(1);
    expect(existsSync(GHOST)).toBe(true);

    // No Topics marker, so the cleanup never moves it: a person can, to quarantine, and back.
    await line.getByTestId("worktrees-quarantine").click();
    const toQuarantine = page.getByRole("dialog", { name: "Mettere in quarantena questa cartella?" });
    await expect(toQuarantine).toBeVisible({ timeout: 10_000 });
    await toQuarantine.getByRole("button", { name: "Metti in quarantena" }).click();
    const parked = list.locator('[data-testid="worktrees-preview-line"][data-class="quarantined"]').filter({ hasText: `ghost-folder-${STAMP}` });
    await expect(parked).toHaveCount(1, { timeout: 20_000 });
    expect(existsSync(GHOST)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("5-in-quarantena.png") });
    await parked.getByTestId("worktrees-restore").click();
    const restore = page.getByRole("dialog", { name: "Ripristinare questa cartella?" });
    await expect(restore).toBeVisible({ timeout: 10_000 });
    await restore.getByRole("button", { name: "Ripristina" }).click();
    await expect(line).toHaveCount(1, { timeout: 20_000 });
    expect(existsSync(GHOST)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-machine and cross-harness: the machines list and the registration door.
// ---------------------------------------------------------------------------

const DEVICE_COOKIE = "w".repeat(32);
const NODE_SUMMARY = {
  root: "/srv/nodes/worktrees", count: 4, bytes: 3 * 1024 ** 3, rootFreeGb: 120, foreign: 2,
  ghosts: 0, orphans: 0, scanMs: 5, at: "2026-01-01T00:00:00.000Z",
};

/** A paired node as far as pairing, the version probe and the worktree summary need it. `modern` false = built before the protocol. */
function nodeHandler(name: string, modern: boolean): Parameters<typeof createServer>[1] {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/api/auth/pair/request") return send(200, { requestId: "r", claim: "c", code: "123456", name, expiresInMs: 60_000 });
    if (req.method === "GET" && url.pathname === "/api/auth/pair/status") return send(200, { state: "approved", name }, { "Set-Cookie": `topics_device=${DEVICE_COOKIE}; Path=/; HttpOnly` });
    if (req.method === "GET" && url.pathname === "/api/version") return send(200, modern ? { version: "9.9.9", worktreeStandard: 1 } : { version: "1.0.0" });
    if (modern && req.method === "GET" && url.pathname === "/api/nodes/worktrees") return send(200, { summary: NODE_SUMMARY });
    send(404, { error: "no" });
  };
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    });
  });
}

// Unique per run: the test server keeps its home between runs, and a folder an earlier run left under the root would read as a second hit.
const HOOK_NAME = `hook-${STAMP}`;
const TOOL_NAME = `tool-${STAMP}`;

type MachineLines = { machines: Array<{ machineId: string; name: string; local: boolean; supported: boolean | null }> };

/** The preview line of a folder, with the whole list open (the first lines only show the heaviest). */
async function previewLine(panel: Locator, folder: string): Promise<Locator> {
  await panel.getByTestId("worktrees-preview-open").click();
  const list = panel.getByTestId("worktrees-preview-list");
  await expect(list).toBeVisible({ timeout: 20_000 });
  const more = panel.getByRole("button", { name: /Mostra tutte/ });
  if (await more.isVisible().catch(() => false)) await more.click();
  const line = list.locator('[data-testid="worktrees-preview-line"]').filter({ hasText: folder });
  await line.scrollIntoViewIfNeeded();
  return line;
}

/** `{default root}/{slug}` of the probe repository: the hook and the tool both place their checkouts there. */
const slugRoot = () => join(E2E_DATA_DIR, ".topics-home", "worktrees", `e2e-wt-cross-${STAMP}`);

test.describe("Impostazioni dei worktree: macchine e strumenti", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  const closers: Array<() => void> = [];
  const machineIds: string[] = [];
  const topicIds: string[] = [];
  let repo = "";
  let hookEnv: NodeJS.ProcessEnv = {};

  test.beforeAll(async ({ request }) => {
    // The default root: what an installation with nothing configured does.
    const cleared = await request.put(`${E2E_BASE}/api/app-settings`, { data: { worktreeRoot: null } });
    expect(cleared.ok()).toBe(true);

    for (const [name, modern] of [["e2e-node-modern", true], ["e2e-node-old", false]] as const) {
      const node = await listen(nodeHandler(name, modern));
      closers.push(() => { node.server.close(); node.server.closeAllConnections(); });
      const opened = await request.post(`${E2E_BASE}/api/machines/pair`, { data: { baseUrl: node.url } });
      const { pairingId } = (await opened.json()) as { pairingId: string };
      const done = (await (await request.get(`${E2E_BASE}/api/machines/pair/${pairingId}`)).json()) as { state: string; machine: { id: string } };
      expect(done.state).toBe("approved");
      machineIds.push(done.machine.id);
      await request.patch(`${E2E_BASE}/api/machines/${done.machine.id}`, { data: { name } });
    }

    // A repository that is a project, and the environment a tool outside Topics runs in:
    // the test server's own home (token and hook script) and its address.
    repo = canonicalTmpDir("e2e-wt-cross");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "# cross\n");
    initGitRepo(repo, "init");
    // A registration for a repository that no project owns is only an inventory answer: make the project.
    const made = await request.post(`${E2E_BASE}/api/projects`, { data: { name: `e2e-wt-cross-${STAMP}`, slug: `e2e-wt-cross-${STAMP}`, path: repo } });
    expect(made.status(), await made.text()).toBe(201);
    topicIds.push((await createTopic(request, `e2e-wt-cross-chat-${STAMP}`, { projectPath: repo })).id);
    hookEnv = { ...process.env, TOPICS_HOME: join(E2E_DATA_DIR, ".topics-home"), TOPICS_APP_URL: E2E_BASE };
    delete hookEnv.TOPICS_WORKTREES_DIR;
  });

  test.afterAll(async ({ request }) => {
    for (const id of machineIds) await request.delete(`${E2E_BASE}/api/machines/${id}`).catch(() => {});
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    closers.forEach((c) => c());
    // What the two creators put under the default root, and the repository itself.
    for (const name of [HOOK_NAME, TOOL_NAME]) {
      try { execFileSync("git", ["worktree", "remove", "--force", join(slugRoot(), name)], { cwd: repo, stdio: "pipe" }); } catch { /* never made */ }
    }
    removeTmpDir(slugRoot());
    removeTmpDir(repo);
  });

  test("WORKTREE-STD-11: una riga per macchina, il nodo che riferisce con i suoi numeri e il nodo vecchio che lo dice", async ({ page, request }, testInfo) => {
    // The meeting this test films (spec-flow D19): a node paired as a device (MACHINE-02)
    // is a line of the worktrees form.
    testInfo.annotations.push({ type: "spec", description: "WORKTREE-STD-11 MACHINE-02" });
    // The node reports on the primary's 30 s probe: wait for its answer before the form opens.
    await expect.poll(async () => {
      const body = (await (await request.get(`${E2E_BASE}/api/machines/worktrees`)).json()) as MachineLines;
      const by = (n: string) => body.machines.find((m) => m.name === n)?.supported ?? null;
      return `${by("e2e-node-modern")}/${by("e2e-node-old")}`;
    }, { timeout: 70_000, message: "the primary never probed the two nodes" }).toBe("true/false");

    const panel = await openForm(page);
    const lines = panel.getByTestId("worktrees-machine-line");
    await expect(lines.first()).toBeVisible({ timeout: 15_000 });
    // This machine first, then the nodes: one line each.
    await expect(lines.first()).toContainText("questa macchina");
    const modern = lines.filter({ hasText: "e2e-node-modern" });
    await expect(modern).toHaveCount(1);
    await expect(modern).toContainText("4 worktree");
    await expect(modern).toContainText("3 GB");
    await expect(modern).toContainText("120 GB liberi");
    await expect(modern).toContainText("fuori radice: 2");
    const old = lines.filter({ hasText: "e2e-node-old" });
    await expect(old).toHaveCount(1);
    await expect(old).toContainText("nodo vecchio");
    await modern.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("5-una-riga-per-macchina.png") });
  });

  test("WORKTREE-STD-13: un worktree nato dall'hook di Claude Code è registrato subito, non aspetta il giro di pulizia", async ({ page, request }, testInfo) => {
    const payload = JSON.stringify({ hook_event_name: "WorktreeCreate", session_id: `e2e-session-${STAMP}`, transcript_path: join(repo, "transcript.jsonl"), cwd: repo, name: HOOK_NAME });
    const out = execFileSync("sh", [join(process.cwd(), "scripts/claude-hooks/worktree-hook.sh"), "create"], { cwd: repo, env: hookEnv, input: payload, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const made = out.trim().split("\n").pop()!;
    expect(existsSync(join(made, ".git"))).toBe(true);
    expect(made.endsWith(`/${HOOK_NAME}`)).toBe(true);

    // The row exists the moment the script returns: no wait for the half-hourly pass.
    const rows = (await (await request.get(`${E2E_BASE}/api/worktrees`)).json()) as Array<{ absPath: string; status: string; source?: string }> | { worktrees: Array<{ absPath: string; status: string; source?: string }> };
    const row = (Array.isArray(rows) ? rows : rows.worktrees).find((w) => w.absPath === made);
    expect(row, "the hook's worktree has no row right after it was made").toBeTruthy();
    expect(row!.status).toBe("ready");
    expect(row!.source).toBe("claude-code");
    // The lock of its creator is on the checkout.
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("locked claude-code:");

    const panel = await openForm(page);
    const line = await previewLine(panel, HOOK_NAME);
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("data-class", "tracked");
    await expect(line).toContainText("di Topics");
    await page.screenshot({ path: testInfo.outputPath("6-worktree-dell-hook-registrato.png") });
  });

  test("WORKTREE-STD-14: un worktree nato da topics-worktree add è registrato subito, con il suo creatore", async ({ page, request }, testInfo) => {
    const out = execFileSync("sh", [join(process.cwd(), "scripts/topics-worktree"), "add", repo, TOOL_NAME], {
      cwd: repo, env: { ...hookEnv, TOPICS_WORKTREE_CREATOR: "codex" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const made = out.trim().split("\n").pop()!;
    expect(existsSync(join(made, ".git"))).toBe(true);

    const rows = (await (await request.get(`${E2E_BASE}/api/worktrees`)).json()) as Array<{ absPath: string; source?: string }> | { worktrees: Array<{ absPath: string; source?: string }> };
    const row = (Array.isArray(rows) ? rows : rows.worktrees).find((w) => w.absPath === made);
    expect(row, "the tool's worktree has no row right after it was made").toBeTruthy();
    expect(row!.source).toBe("codex");
    // Written down by the creator in the checkout's own admin folder, readable without the server.
    const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: made, encoding: "utf8" }).trim();
    expect(JSON.parse(readFileSync(join(gitDir, "topics-owner"), "utf8")).creator).toBe("codex");

    const panel = await openForm(page);
    const line = await previewLine(panel, TOOL_NAME);
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("data-class", "tracked");
    await page.screenshot({ path: testInfo.outputPath("7-worktree-dello-strumento-registrato.png") });
  });
});
