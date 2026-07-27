/**
 * external-sessions.spec.ts — the Claude sessions Topics did NOT start show up
 * on the board.
 *
 * Topics only knows the sessions it spawned, so a repo worked by hand from a
 * terminal reads as "fermo" on the kanban. The server now takes a census of
 * `~/.claude/projects/*.jsonl` (see server/lib/external-claude-sessions.ts) and
 * the board header carries a read-only badge for it.
 *
 * The test server runs with HOME=/tmp/topics-test-data/.home (see
 * scripts/start-test-server.sh), so seeding a transcript under THAT home is
 * exactly what a bare `claude` would write — no mocks, the real scan path.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";

const BASE = "http://localhost:13334";
const TEST_HOME = "/tmp/topics-test-data/.home";
const PROJECT_PATH = `/tmp/e2e-extsess-${Date.now()}`;
/** Claude Code encodes the cwd by replacing every `/` and `.` with `-`. */
const encodedDir = PROJECT_PATH.replace(/[/.]/g, "-");
const TRANSCRIPT_DIR = `${TEST_HOME}/.claude/projects/${encodedDir}`;
const SESSION_ID = "e2e11111-2222-3333-4444-555555555555";

let projectTopicId: string | null = null;

/** Write the transcript a bare `claude` session would leave behind. */
function seedExternalSession(cwd = PROJECT_PATH, branch = "main"): void {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const entry = {
    type: "user",
    uuid: "u1",
    timestamp: new Date().toISOString(),
    cwd,
    sessionId: SESSION_ID,
    entrypoint: "cli",
    gitBranch: branch,
    message: { role: "user", content: "ciao" },
  };
  writeFileSync(`${TRANSCRIPT_DIR}/${SESSION_ID}.jsonl`, JSON.stringify(entry) + "\n");
}

/** Open the e2e project window by clicking its sidebar row. */
async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: /e2e-extsess/ })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

/** Open the project board pane via the project window's "+" menu. */
async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  for (let i = count - 1; i >= 0; i--) {
    await triggers.nth(i).click();
    const found = await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
    if (found) break;
    await page.keyboard.press("Escape");
    if (i === 0) throw new Error("no + menu with a Board (kanban) entry found");
  }
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Sessioni Claude fuori dalla kanban", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-extsess" }, null, 2));
    // The topic gives the project a path the server already knows, so the
    // census can attribute the session's cwd to this board.
    const topic = await createTopic(request, "E2E-ExtSess", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    seedExternalSession();
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []).catch(() => {});
    await seedProjectPane(page.request, PROJECT_PATH).catch(() => {});
  });

  test("EXTSESS-01: /api/external-sessions reports the bare session with project, branch and last activity", async ({ request }) => {
    // The census is TTL-cached server-side; poll until the seeded transcript
    // lands (this is also the "entro un minuto" acceptance criterion).
    await expect.poll(async () => {
      const res = await request.get(`${BASE}/api/external-sessions`);
      if (!res.ok()) return null;
      const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
      return body.sessions.find((s) => s.sessionId === SESSION_ID) ?? null;
    }, { timeout: 45_000, intervals: [1000] }).not.toBeNull();

    const res = await request.get(`${BASE}/api/external-sessions`);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; cwd: string; projectPath: string | null; branch: string | null; state: string; lastActivityMs: number }>;
      projects: Array<{ projectPath: string; active: number }>;
    };
    const mine = body.sessions.find((s) => s.sessionId === SESSION_ID)!;
    expect(mine.cwd).toBe(PROJECT_PATH);
    expect(mine.projectPath).toBe(PROJECT_PATH);
    expect(mine.branch).toBe("main");
    expect(mine.state).toBe("active");
    expect(body.projects.some((p) => p.projectPath === PROJECT_PATH && p.active >= 1)).toBe(true);
  });

  test("EXTSESS-02: the board header badge names the session Topics doesn't govern", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);

    const badge = page.getByTestId("external-sessions-badge");
    await expect(badge).toBeVisible({ timeout: 45_000 });
    await badge.click();

    // The popover names the directory and the branch — enough for the human to
    // recognise their own terminal.
    await expect(page.getByText("Sessioni fuori dalla kanban")).toBeVisible();
    const row = page.locator("li").filter({ hasText: PROJECT_PATH.split("/").pop()! }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("main");
  });
});
