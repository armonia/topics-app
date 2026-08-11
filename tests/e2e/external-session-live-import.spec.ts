/**
 * external-session-live-import.spec.ts — the adopted chat no longer FREEZES at
 * the adoption snapshot: turns typed in the TERMINAL keep flowing into Topics.
 *
 * The bug: `adopt-claude` read the transcript ONCE and never again for messages,
 * so after adoption the chat was a still photo. The fix persists `jsonl_path` +
 * `import_offset` at adoption and runs an import sweep that re-reads the tail and
 * appends the new turns. This test proves the end-to-end behaviour a unit test
 * can't: adopt a live session, open its chat, then append a fresh turn to the
 * SAME transcript on disk (what a bare `claude` in a terminal does) and watch it
 * appear in the open chat within one sweep. Under E2E_EVIDENCE=1 the run records
 * the .webm that IS the acceptance proof.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const TEST_HOME = E2E_HOME;

// Markers so we assert OUR turns, not some other row.
const HIST_USER = "import-storia-domanda";
const HIST_ASSISTANT = "import-storia-risposta";
const LIVE_USER = "import-live-domanda-DAL-TERMINALE";
const LIVE_ASSISTANT = "import-live-risposta-DAL-TERMINALE";

/** Claude Code encodes the cwd by replacing every `/` and `.` with `-`. */
const encode = (p: string) => p.replace(/[/.]/g, "-");
const transcriptPath = (cwd: string, sessionId: string) =>
  `${TEST_HOME}/.claude/projects/${encode(cwd)}/${sessionId}.jsonl`;

/** One user→assistant turn — the history a bare `claude` already left on disk. */
function seedSession(cwd: string, sessionId: string): void {
  mkdirSync(`${TEST_HOME}/.claude/projects/${encode(cwd)}`, { recursive: true });
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "h1", timestamp: "2026-07-30T10:00:00Z", message: { role: "user", content: HIST_USER } },
    { ...base, type: "assistant", uuid: "h2", timestamp: "2026-07-30T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: HIST_ASSISTANT }] } },
  ];
  writeFileSync(transcriptPath(cwd, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Append a NEW turn to the SAME transcript — exactly what continuing the
 *  session in a terminal does. */
function appendTerminalTurn(cwd: string, sessionId: string): void {
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "l1", timestamp: "2026-07-30T10:05:00Z", message: { role: "user", content: LIVE_USER } },
    { ...base, type: "assistant", uuid: "l2", timestamp: "2026-07-30T10:05:01Z", message: { role: "assistant", content: [{ type: "text", text: LIVE_ASSISTANT }] } },
  ];
  appendFileSync(transcriptPath(cwd, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function waitForCensus(request: import("@playwright/test").APIRequestContext, sessionId: string) {
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/external-sessions`);
    if (!res.ok()) return null;
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    return body.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }, { timeout: 45_000, intervals: [1000] }).not.toBeNull();
}

async function openTestProject(page: Page, projectMatch: RegExp) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page.locator('[aria-label="Topics sidebar"] button').filter({ hasText: projectMatch }).first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page, projectMatch: RegExp) {
  await openTestProject(page, projectMatch);
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

test.describe("Sessione adottata: i turni dal terminale continuano ad arrivare", () => {
  test.describe.configure({ timeout: 90_000 });

  const CWD = `/tmp/e2e-live-import-${Date.now()}`;
  const SID = "ad0d7000-9999-8888-7777-666666666666";

  test.beforeAll(async ({ request }) => {
    mkdirSync(CWD, { recursive: true });
    writeFileSync(`${CWD}/package.json`, JSON.stringify({ name: "e2e-live-import" }, null, 2));
    await createTopic(request, "e2e-live-import", { projectPath: CWD });
    seedSession(CWD, SID);
  });

  test.afterAll(async () => {
    rmSync(`${TEST_HOME}/.claude/projects/${encode(CWD)}`, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, CWD).catch(() => {});
  });

  test("a terminal turn appears in the adopted chat within one sweep", async ({ page, request }) => {
    await waitForCensus(request, SID);

    await page.goto("/");
    await openProjectBoard(page, /e2e-live-import/);

    // Adopt from the board — the chat opens with the imported history.
    const badge = page.getByTestId("external-sessions-badge");
    await expect(badge).toBeVisible({ timeout: 45_000 });
    await badge.click();
    const adoptBtn = page.getByTestId("adopt-external-session").first();
    await expect(adoptBtn).toBeVisible();
    await adoptBtn.click();

    await expect(page.getByTestId("message-content-user").filter({ hasText: HIST_USER })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: HIST_ASSISTANT })).toBeVisible({ timeout: 20000 });

    // THE PROOF: continue the session in the terminal — a fresh turn is appended
    // to the SAME transcript on disk. Topics wasn't told; only the JSONL grew.
    appendTerminalTurn(CWD, SID);

    // The import sweep (≤1.5s interval) picks it up and the open chat appends it
    // live via `message:new`. No reload, no user action.
    await expect(page.getByTestId("message-content-user").filter({ hasText: LIVE_USER })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: LIVE_ASSISTANT })).toBeVisible({ timeout: 20000 });

    // Clean up the topic the UI created.
    const list = await request.get(`${BASE}/api/topics`);
    const body = (await list.json()) as { topics: Record<string, { id: string; name: string }> };
    for (const t of Object.values(body.topics ?? {})) {
      if (/e2e-live-import \(ripresa\)/.test(t.name)) await deleteTopic(request, t.id).catch(() => {});
    }
  });
});
