/**
 * @covers TERM-02
 *
 * A window refresh must not lose any Claude Code tab of a project, and must
 * reattach them fast.
 *
 * Reported 13/10: after a refresh Topics stayed loading and some Claude Code
 * tabs were gone until refreshed again. The tab count after EVERY refresh is
 * the proof of loss; the time to `replay-end` on the terminal WebSocket is the
 * loading measure. The attached-client counts it prints are why the idle park
 * now spares open tabs (`server/lib/terminal-idle-park.ts`, `open-tab`).
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import { hermetic } from "./fixtures/hermetic";
import { deleteAllTerminalSessions } from "./helpers/api-fixtures";
import { restartTestServer } from "./helpers/restart-test-server";
import {
  cleanupTerminalTopic,
  gotoTerminalProject,
  projectRowSelector,
  resetTerminalWorkspace,
  seedTerminalTopic,
} from "./helpers/terminal-workspace";

hermetic(test);

const SESSIONS = 3;
const RELOADS = 5;

/**
 * The terminal-tab prune waits for the PARKED-session list
 * (`useProjectTerminalSync`, `guard.loaded`): until it arrives nothing is
 * removed. So "the tabs stay" is read AFTER that response and a frame.
 */
async function afterPrunePass(page: Page, dormantRead: Promise<unknown>): Promise<void> {
  await dormantRead;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** "+" on the project row, then "Claude Code": the gesture real tabs are born from. */
async function addClaudeCode(page: Page): Promise<void> {
  const row = page.locator(projectRowSelector()).first();
  await row.hover();
  await row.locator("..").locator('button[title="Add to project"], button[data-tip="Add to project"]').first().click();
  await page.getByTestId("pane-add-menu-claude-code").click();
}

/** Milliseconds from the start to the first `replay-end` of each listed session. */
function watchReplayEnd(page: Page, ids: string[], t0: () => number): Map<string, number> {
  const seen = new Map<string, number>();
  page.on("websocket", (ws) => {
    const id = ids.find((i) => ws.url().endsWith(`/ws/terminal/${i}`));
    if (!id) return;
    ws.on("framereceived", (f) => {
      if (seen.has(id) || typeof f.payload !== "string") return;
      if (f.payload.includes('"replay-end"')) seen.set(id, Date.now() - t0());
    });
  });
  return seen;
}

test.describe.serial("Refresh con più Claude Code aperti", () => {
  let topicId: string | undefined;
  let topicName = "";
  const ids: string[] = [];

  test.beforeAll(async ({ request }) => {
    ({ topicId, topicName } = await seedTerminalTopic(request, "refresh"));
    await resetTerminalWorkspace(request, topicId);
  });

  test.afterAll(async ({ request }) => {
    await deleteAllTerminalSessions(request);
    await cleanupTerminalTopic(request, topicId);
  });

  test("ogni refresh tiene tutte le tab e le riaggancia", async ({ page }) => {
    let start = Date.now();
    const replayEnd = watchReplayEnd(page, ids, () => start);
    const tab = (id: string) => page.getByTestId(`pane-tab-terminal:${id}`);
    const tabs = page.locator('[data-testid^="pane-tab-terminal:"]');

    await gotoTerminalProject(page, topicName);
    for (let i = 1; i <= SESSIONS; i++) {
      await addClaudeCode(page);
      await expect(tabs).toHaveCount(i, { timeout: 20_000 });
    }
    for (const t of await tabs.all()) ids.push(((await t.getAttribute("data-testid")) ?? "").replace("pane-tab-terminal:", ""));

    const clients = async () => {
      const res = await page.request.get("/api/terminal/sessions");
      const list = (await res.json()) as Array<{ id: string; clients: number }>;
      return ids.map((id) => list.find((s) => s.id === id)?.clients ?? -1);
    };
    console.log(`client agganciati PRIMA del refresh: ${(await clients()).join(",")}`);
    const report: string[] = [];
    for (let r = 1; r <= RELOADS; r++) {
      replayEnd.clear();
      start = Date.now();
      const dormantRead = page.waitForResponse((r) => r.url().includes("/api/terminal/sessions/dormant"));
      await page.reload();
      // Every tab comes back: THIS is the reported loss.
      for (const id of ids) await expect(tab(id), `refresh ${r}: tab ${id} persa`).toBeVisible({ timeout: 20_000 });
      const tabsMs = Date.now() - start;
      // And they stay: a prune lands after the parked list, never before.
      await afterPrunePass(page, dormantRead);
      const present = await Promise.all(ids.map((id) => tab(id).count()));
      expect(present, `refresh ${r}: tab sparite dopo il primo roster`).toEqual(ids.map(() => 1));
      const firstAttach = Math.min(...replayEnd.values());
      report.push(`client ${(await clients()).join(",")} · refresh ${r}: tab ${tabsMs} ms · primo replay-end ${Number.isFinite(firstAttach) ? firstAttach : "mai"} ms · agganciate ${replayEnd.size}/${ids.length}`);
    }
    test.info().annotations.push({ type: "misura", description: report.join("\n") });
    console.log(report.join("\n"));
  });

  test("un refresh mentre il server riparte non perde tab @nightly", async ({ page }) => {
    test.setTimeout(240_000);
    const tab = (id: string) => page.getByTestId(`pane-tab-terminal:${id}`);
    await page.goto("/");
    for (const id of ids) await expect(tab(id)).toBeVisible({ timeout: 20_000 });

    const report: string[] = [];
    for (let r = 1; r <= 3; r++) {
      // The refresh starts while the server is down, as when the production
      // watcher reloads it because someone touched `server/`.
      const dormantRead = page.waitForResponse((r) => r.url().includes("/api/terminal/sessions/dormant") && r.ok(), { timeout: 60_000 });
      const restarting = restartTestServer();
      const start = Date.now();
      await page.reload().catch(() => {});
      await restarting;
      for (const id of ids) await expect(tab(id), `riavvio ${r}: tab ${id} persa`).toBeVisible({ timeout: 30_000 });
      const tabsMs = Date.now() - start;
      await afterPrunePass(page, dormantRead);
      const present = await Promise.all(ids.map((id) => tab(id).count()));
      expect(present, `riavvio ${r}: tab sparite dopo il primo roster`).toEqual(ids.map(() => 1));
      report.push(`riavvio ${r}: tab ${tabsMs} ms`);
    }
    console.log(report.join("\n"));
  });
});
