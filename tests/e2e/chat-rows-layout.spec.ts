import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The rows of a transcript share one grid: thinking, tools, sub-agents and
 * board cards read as one list, and nothing is drawn with no words in it.
 *
 *  - a row never comes out EMPTY: a sub-agent or board-card call that carries
 *    no description (a `Task` with no `description`, a `spawn_agent` with no
 *    name or prompt, a card call with no title) used to draw a robot icon and
 *    nothing else, and stayed so after the call settled;
 *  - the running tool is not wrapped in a tinted box with its own radius: it is
 *    flat like the rows around it;
 *  - one line per thing: a row says its label once and the card under it only
 *    the detail (no «Card» over «Card», no «Sub-agent» over the card's own
 *    sub-agent name);
 *  - a finished sub-agent call with nothing to show is not drawn; a failed one
 *    is, with that state;
 *  (the distance to the sub-agents bar is `chat-rows-strip.spec.ts`)
 *  - a SUB-AGENT (another chat that works and comes back with a result) and a
 *    BACKGROUND job (a process that runs and wakes the chat when it ends) do
 *    not look alike: other icon, other label.
 *
 * With `ROWS_SHOT_DIR` set, the page is also photographed at 1440, 768 and
 * 375 px (`ROWS_SHOT_TAG` names the files), for the before/after pictures.
 *
 * @covers CHAT-TOOL-14
 */

test.describe("Chat rows: one grid, no row without words", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Chat rows " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    const sessionKey = `topic:${t.id.slice(0, 8)}`;
    const now = Date.now();
    const u = await seedMessage(request, {
      sessionKey, role: "user", content: "fai tutto", timestamp: new Date(now - 9000).toISOString(),
    });
    const tool = (toolCall: Record<string, unknown>) => ({ kind: "tool", toolCall: { startedAt: now - 6000, ...toolCall } });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "",
      timestamp: new Date(now - 8000).toISOString(),
      blocks: [
        { kind: "thinking", text: "Prima guardo il modulo, poi lancio i controlli in parallelo.\n".repeat(3) },
        tool({ id: "rw-todo", name: "TodoWrite", args: { todos: [{ content: "Controllare il modulo", status: "in_progress", activeForm: "Controllo il modulo" }] }, status: "success", endedAt: now - 5900 }),
        tool({ id: "rw-read", name: "Read", args: { file_path: "/tmp/modulo.ts" }, status: "success", result: "export {}", endedAt: now - 5800 }),
        tool({
          id: "rw-sub-ok", name: "Task", args: { description: "Controlla il modulo di pagamento", subagent_type: "Explore" }, status: "success", result: "ok", endedAt: now - 5000,
          detail: { type: "sub_agent", subAgentType: "Explore", description: "Controlla il modulo di pagamento", actions: [], result: "ok" },
        }),
        // The calls below carry nothing to say what they are for, and they are
        // settled with no clock (the history of an older turn): there is no
        // timer to fill the row, and each used to be a bare icon.
        // 1. Finished with nothing at all: no row to draw.
        tool({ id: "rw-sub-empty", name: "Task", args: {}, status: "success", startedAt: undefined, detail: { type: "sub_agent", actions: [] } }),
        // 2. Failed with nothing else: a row with that state and nothing more.
        tool({ id: "rw-sub-failed", name: "Task", args: {}, status: "error", error: "boom", startedAt: undefined, detail: { type: "sub_agent", actions: [] } }),
        // 3. A spawn with only an answer, and a card call with no title.
        tool({ id: "rw-spawn-empty", name: "spawn_agent", args: {}, status: "success", result: "ok", startedAt: undefined, detail: { type: "sub_agent", via: "spawn_agent", actions: [] } }),
        tool({ id: "rw-card-empty", name: "create_task", args: {}, status: "success", startedAt: undefined, detail: { type: "task_card", tool: "create_task", action: "created", args: {} } }),
        tool({ id: "rw-bg-cmd", name: "run_command", args: { command: "bun run dev" }, status: "success", result: "started · processId=proc-1", endedAt: now - 4000 }),
        // A sub-agent between the two background rows keeps them out of one folded group.
        tool({ id: "rw-sub-two", name: "Agent", args: { description: "Riassumi il log", subagent_type: "general-purpose" }, status: "success", result: "ok", endedAt: now - 3950,
          detail: { type: "sub_agent", subAgentType: "general-purpose", description: "Riassumi il log", actions: [], result: "ok" } }),
        tool({ id: "rw-bg-bash", name: "Bash", args: { command: "sleep 600", description: "Server di prova", run_in_background: true }, status: "success", result: "Command running in background with ID: bg1", endedAt: now - 3900 }),
        tool({ id: "rw-run", name: "Bash", args: { command: "bun test", description: "Lancio i test" }, status: "running" }),
        { kind: "thinking", text: "Aspetto l'esito dei controlli.\n".repeat(2) },
      ],
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * One page, one open: the rows are read at 1440, then the same page is
   * narrowed to 768 and 375 for the photos. (Seven separate opens of the same
   * topic on a loaded runner lost the sidebar entry now and then, which is the
   * helper's race and not what is measured here.) Soft assertions, so a failing
   * build reports every row that is wrong, not only the first.
   */
  test("rows on one grid, no row without words, kinds told apart", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Opened from the sidebar, as a person does (the `openTopic` helper re-seeds the pane store and races).
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.getByRole("treeitem", { name: new RegExp(topicName) }).first().click();
    const row = (id: string) => page.locator(`[data-testid="tool-call-row-${id}"]`);
    await expect(row("rw-run")).toBeVisible({ timeout: 15_000 });
    await row("rw-run").scrollIntoViewIfNeeded();

    const shoot = async (width: number) => {
      const dir = process.env.ROWS_SHOT_DIR;
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${process.env.ROWS_SHOT_TAG ?? "shot"}-${width}.png`) });
    };
    await shoot(1440);
    // The photos at the two narrower widths, on the same page, then back to 1440 for the measures.
    for (const width of [768, 375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await row("rw-run").scrollIntoViewIfNeeded();
      if (width !== 1440) await shoot(width);
    }

    // No row is a bare icon; a finished sub-agent with nothing to show is not drawn.
    for (const id of ["rw-sub-failed", "rw-spawn-empty", "rw-card-empty"]) {
      await expect.soft(row(id).locator(":scope > :first-child"), `${id} says what it is`).toHaveText(/\S/);
    }
    await expect.soft(row("rw-sub-empty"), "a finished sub-agent with nothing at all has no row").toHaveCount(0);
    await expect.soft(row("rw-sub-failed"), "a failed call says its error, not «no activity» too").not.toContainText(/Nessuna attività|No activity/i);

    // One line per thing: the label once, under it only the detail.
    await expect.soft(row("rw-spawn-empty").getByTestId("spawn-agent-phase")).toBeVisible();
    await expect.soft(row("rw-spawn-empty").getByTestId("spawn-agent-name"), "the sub-agent label over its own name").toHaveCount(0);
    await expect.soft(row("rw-card-empty").getByTestId("task-card-phase")).toBeVisible();
    await expect.soft(row("rw-card-empty").getByTestId("task-card-title"), "«Card» over a second «Card»").toHaveCount(0);

    // The running tool is flat and on the column of its neighbours.
    const run = await row("rw-run").evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, shadow: s.boxShadow, left: el.getBoundingClientRect().left, siblingLeft: document.querySelector('[data-testid="tool-call-row-rw-read"]')!.getBoundingClientRect().left };
    });
    expect.soft(run.bg, "no tint").toBe("rgba(0, 0, 0, 0)");
    expect.soft(run.shadow, "no ring").toBe("none");
    expect.soft(run.left, "same column as the rows around it").toBe(run.siblingLeft);

    // A sub-agent and a background job do not look alike.
    const read = (id: string) => row(id).evaluate((el) => ({
      kind: el.getAttribute("data-work-kind"),
      icon: el.querySelector("svg")?.getAttribute("class") ?? "",
      label: el.querySelector('[data-testid="tool-call-name"]')?.textContent ?? "",
    }));
    const [sub, spawn, cmd, bash] = await Promise.all(["rw-sub-ok", "rw-spawn-empty", "rw-bg-cmd", "rw-bg-bash"].map(read));
    expect.soft([sub.kind, spawn.kind, cmd.kind, bash.kind]).toEqual(["subagent", "subagent", "background", "background"]);
    expect.soft([sub.label, cmd.label, bash.label]).toEqual(["Sub-agent", "Background", "Background"]);
    expect.soft(sub.icon, "another icon").not.toBe(cmd.icon);

  });
});
