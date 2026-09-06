/**
 * The worktree of a topic, seen from the sidebar.
 *
 * A REAL repo and two REAL worktrees, created through the same API the New
 * Topic dialog uses (`POST /api/worktrees`, then the row flips to `ready`):
 * the test server keeps its own HOME, so the checkouts land under its data
 * dir and never touch `~/.topics/worktrees`. Three topics of that project are
 * open inside it — one per worktree, one in the project's own checkout — and
 * the sidebar has to tell them apart.
 *
 * ONE test, because the three scenarios of TOPIC-WT-02 are three moments of
 * one state: the two sections while both worktrees carry a topic, the "new
 * topic" action from a section header, and then — after one binding is
 * cleared, live over the socket — the chip alone, because a single worktree
 * earns no section.
 *
 * @covers TOPIC-WT-02
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createTopic, deleteTopic, patchTopic, seedProjectInnerChats, seedProjectPane } from "./helpers/api-fixtures";
import { initGitRepo } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const API = `${E2E_BASE}/api`;

interface WorktreeRow {
  id: string;
  name: string;
  status: "pending" | "ready" | "error";
  branchName: string | null;
}

async function pollForReady(request: APIRequestContext, id: string, timeoutMs = 10_000): Promise<WorktreeRow> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request.get(`${API}/worktrees/${id}`);
    if (res.ok()) {
      const wt = (await res.json()) as WorktreeRow;
      if (wt.status !== "pending") return wt;
    }
    // The sampling interval of the poll: the loop is the condition.
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Worktree ${id} did not leave pending in ${timeoutMs}ms`);
}

async function makeWorktree(request: APIRequestContext, projectId: string): Promise<WorktreeRow> {
  const res = await request.post(`${API}/worktrees`, {
    data: { project_id: projectId, mode: "branch", base_ref: "main" },
  });
  expect(res.status(), "POST /api/worktrees answers 202 with a pending row").toBe(202);
  const ready = await pollForReady(request, ((await res.json()) as WorktreeRow).id);
  expect(ready.status).toBe("ready");
  return ready;
}

const repoRaw = `/tmp/topics-e2e-sidebar-wt-${Date.now()}`;
const projectName = repoRaw.slice("/tmp/".length);
/**
 * The CANONICAL path (`/private/tmp/…` on macOS), for the project row and the
 * topics alike. The topics route stores a topic's `projectPath` resolved, the
 * project store keeps what it was given, and `GET /api/projects?path=` is an
 * exact match: seeded with the symlinked `/tmp/…` the dialog never finds the
 * project behind the topic and draws no worktree picker at all.
 */
let repo = repoRaw;
const topics: string[] = [];
let alpha: WorktreeRow;
let beta: WorktreeRow;
let topicBeta: string;

const sections = (page: Page) => page.locator('[role="group"][data-testid^="worktree-section-"]');

const sidebarOf = (page: Page) => page.locator('[role="navigation"][aria-label="Topics sidebar"]');

/**
 * The column on screen, whatever the load left it. Under 768px the sidebar is
 * a drawer that starts closed over a focused pane; on a desktop it can start
 * collapsed too. Both moves are a transform with a transition, and a running
 * transition is an Animation on the element: "open" is "no slide in flight,
 * the box starts at x = 0 AND has a width", never a reading taken mid-slide.
 * The width matters: the closed drawer is `width: 0` + `translateX(-100%)`,
 * so its left edge reads 0 exactly like an open one.
 */
async function ensureSidebarOpen(page: Page): Promise<void> {
  const sidebar = sidebarOf(page);
  const state = () => sidebar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { moving: el.getAnimations().length > 0, left: Math.round(r.left), width: Math.round(r.width) };
  });
  const open = (s: { moving: boolean; left: number; width: number }) => !s.moving && s.left === 0 && s.width > 0;
  await expect.poll(async () => (await state()).moving, { timeout: 10_000 }).toBe(false);
  if (!open(await state())) {
    await page.getByRole("button", { name: /Toggle sidebar|Expand sidebar/ }).first().click();
  }
  await expect.poll(async () => open(await state()), { timeout: 10_000 }).toBe(true);
}

/**
 * Open the app with the project's accordion open, and wait for its rows.
 * Idempotent on purpose: a click on a project that is already focused and
 * open would CLOSE the accordion (desktop), or enter the project and shut the
 * drawer (phone), so the row is clicked only when the accordion is shut.
 */
async function openProject(page: Page): Promise<void> {
  await page.goto("/");
  await ensureSidebarOpen(page);
  const row = page.getByTestId(`project-toggle-${projectName}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const collapse = page.getByRole("button", { name: `Collapse ${projectName}` });
  if ((await collapse.count()) === 0) await row.click();
  await expect(collapse).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("treeitem", { name: "E2E-WT-Base" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Sidebar — worktree of a topic", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(repoRaw, { recursive: true });
    repo = realpathSync(repoRaw);
    // One file, or the first commit has nothing to record and git refuses.
    writeFileSync(`${repo}/README.md`, "# e2e\n");
    initGitRepo(repo);
    const project = (await (await request.post(`${API}/projects`, {
      data: { name: projectName, path: repo },
    })).json()) as { id: string };
    alpha = await makeWorktree(request, project.id);
    beta = await makeWorktree(request, project.id);

    const a = await createTopic(request, "E2E-WT-Alpha", { projectPath: repo, worktreeId: alpha.id });
    const b = await createTopic(request, "E2E-WT-Beta", { projectPath: repo, worktreeId: beta.id });
    const base = await createTopic(request, "E2E-WT-Base", { projectPath: repo });
    topicBeta = b.id;
    topics.push(a.id, b.id, base.id);
    // Open INSIDE the project, as the sidebar is tab-driven: a topic with no
    // pane is not a row.
    await seedProjectPane(request, repo);
    await seedProjectInnerChats(request, repo, [a.id, b.id, base.id]);
  });

  test.afterAll(async ({ request }) => {
    for (const id of topics) await deleteTopic(request, id).catch(() => {});
    for (const wt of [alpha, beta]) {
      if (wt) await request.delete(`${API}/worktrees/${wt.id}`).catch(() => {});
    }
    rmSync(repoRaw, { recursive: true, force: true });
  });

  test("TOPIC-WT-02: two worktrees give two sections and a header action; one worktree gives the chip alone", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-WT-02" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProject(page);

    // ── 1. Sections: one per worktree, the unbound topic in the base list ──
    const sectionAlpha = page.getByTestId(`worktree-section-${alpha.id}`);
    const sectionBeta = page.getByTestId(`worktree-section-${beta.id}`);
    await expect(sections(page)).toHaveCount(2);
    // Header: the worktree's name and its branch, both read off the entity.
    await expect(sectionAlpha).toHaveAttribute("aria-label", `Worktree ${alpha.name}`);
    await expect(sectionAlpha.locator('[data-row-name="worktree"]')).toHaveText(alpha.name);
    await expect(sectionAlpha).toContainText(alpha.branchName!);
    await expect(sectionBeta.locator('[data-row-name="worktree"]')).toHaveText(beta.name);
    // Each bound topic under its own header, the unbound one under none.
    await expect(sectionAlpha.getByRole("treeitem", { name: "E2E-WT-Alpha" })).toBeVisible();
    await expect(sectionBeta.getByRole("treeitem", { name: "E2E-WT-Beta" })).toBeVisible();
    await expect(sections(page).getByRole("treeitem", { name: "E2E-WT-Base" })).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: "E2E-WT-Base" })).toBeVisible();
    // Inside its section a row does not repeat the chip: the header says it.
    await expect(sectionAlpha.locator("[data-worktree-chip]")).toHaveCount(0);

    await sidebarOf(page).screenshot({ path: test.info().outputPath("sidebar-worktree-1440.png") });

    // ── 2. "New topic in this worktree" opens the dialog, worktree picked ──
    const header = page.locator(`[data-worktree-header="${beta.id}"]`);
    await header.hover();
    await page.getByTestId(`worktree-new-topic-${beta.id}`).click();
    const dialog = page.getByRole("dialog", { name: "New Topic" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Not a second picker: the dialog's own radio, already on "pick existing",
    // and its own select, already on this worktree.
    await expect(dialog.getByRole("radio", { name: /Pick existing worktree/ })).toBeChecked({ timeout: 10_000 });
    await expect(dialog.getByRole("combobox", { name: "Worktree" })).toContainText(beta.name);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The phone: the same tree in the full-width drawer, on a FRESH load at
    // 390px. Resizing a live page would only catch the drawer sliding shut
    // over the focused pane; a load starts where a phone starts.
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page);
    await expect(sectionAlpha).toBeVisible();
    await expect(sectionBeta).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("sidebar-worktree-390.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProject(page);

    // ── 3. One worktree left: no section, the chip alone says it ──────────
    // Cleared over the API; the sidebar follows the `topic:updated` envelope
    // without a reload, the way a change from another window would arrive.
    await patchTopic(request, topicBeta, { worktreeId: null });
    await expect(sections(page)).toHaveCount(0, { timeout: 10_000 });
    const alphaRow = page.getByRole("treeitem", { name: "E2E-WT-Alpha" });
    const chip = alphaRow.locator(`[data-worktree-chip="${alpha.id}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(alpha.name);
    await expect(chip).toHaveAttribute("aria-label", `Nel worktree ${alpha.name}`);
    await expect(page.getByRole("treeitem", { name: "E2E-WT-Beta" }).locator("[data-worktree-chip]")).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: "E2E-WT-Base" }).locator("[data-worktree-chip]")).toHaveCount(0);
  });
});
