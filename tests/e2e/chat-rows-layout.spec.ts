import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
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
 *  - the last row of a message does not touch the strips under the transcript;
 *  - a SUB-AGENT (another chat that works and comes back with a result) and a
 *    BACKGROUND job (a process that runs and wakes the chat when it ends) do
 *    not look alike: other icon, other label.
 *
 * With `ROWS_SHOT_DIR` set, the page is also photographed at 375, 768 and
 * 1440 px (`ROWS_SHOT_TAG` names the files), for the before/after pictures.
 *
 * @covers CHAT-TOOL-14
 */

const WIDTHS = [375, 768, 1440] as const;

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
        // The three calls below carry nothing to say what they are for, and
        // they are settled with no clock (the history of an older turn): the
        // row has no timer to fill it, and used to stay a bare icon.
        tool({ id: "rw-sub-empty", name: "Task", args: {}, status: "success", result: "ok", startedAt: undefined, detail: { type: "sub_agent", actions: [] } }),
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

  async function open(page: Page, width: number) {
    await page.setViewportSize({ width, height: 900 });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await expect(page.locator('[data-testid="tool-call-row-rw-run"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="tool-call-row-rw-run"]').scrollIntoViewIfNeeded();
  }

  for (const width of WIDTHS) {
    test(`${width} px: photo of the rows, and no row without words`, async ({ page }) => {
      await open(page, width);
      const dir = process.env.ROWS_SHOT_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, `${process.env.ROWS_SHOT_TAG ?? "shot"}-${width}.png`) });
      }
      for (const id of ["rw-sub-empty", "rw-spawn-empty", "rw-card-empty"]) {
        const head = page.locator(`[data-testid="tool-call-row-${id}"] > :first-child`);
        await expect(head, `${id} says what it is`).toHaveText(/\S/);
      }
    });
  }

  test("the running tool is flat: no tint, no ring, on the column of its neighbours", async ({ page }) => {
    await open(page, 1440);
    const style = await page.locator('[data-testid="tool-call-row-rw-run"]').evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        bg: s.backgroundColor,
        shadow: s.boxShadow,
        left: el.getBoundingClientRect().left,
        siblingLeft: document.querySelector('[data-testid="tool-call-row-rw-read"]')!.getBoundingClientRect().left,
      };
    });
    expect(style.bg).toBe("rgba(0, 0, 0, 0)");
    expect(style.shadow).toBe("none");
    expect(style.left).toBe(style.siblingLeft);
  });

  test("the last row of the message does not touch the strips under it", async ({ page }) => {
    await open(page, 1440);
    // This chat has no goal, todo or live work, so the strips' slot is empty:
    // a probe stands in for the first strip (the slot gives it its distance).
    const gap = await page.evaluate(() => {
      const slot = document.querySelector('[data-testid="chat-end-strips"]')!;
      const probe = document.createElement("div");
      probe.style.height = "20px";
      slot.appendChild(probe);
      const rows = [...document.querySelectorAll('[data-testid="reasoning-row"]')];
      const last = rows[rows.length - 1].getBoundingClientRect();
      return probe.getBoundingClientRect().top - last.bottom;
    });
    expect(gap, "gap between the last row and the first strip, px").toBeGreaterThanOrEqual(10);
  });

  test("a sub-agent and a background job do not look alike", async ({ page }) => {
    await open(page, 1440);
    const read = async (id: string) => page.locator(`[data-testid="tool-call-row-${id}"]`).evaluate((el) => ({
      kind: el.getAttribute("data-work-kind"),
      icon: el.querySelector("svg")?.getAttribute("class") ?? "",
      label: el.querySelector('[data-testid="tool-call-name"]')?.textContent ?? "",
    }));
    const sub = await read("rw-sub-ok");
    const spawn = await read("rw-spawn-empty");
    const cmd = await read("rw-bg-cmd");
    const bash = await read("rw-bg-bash");
    expect(sub.kind).toBe("subagent");
    expect(spawn.kind).toBe("subagent");
    expect(cmd.kind).toBe("background");
    expect(bash.kind).toBe("background");
    expect(sub.label).toBe("Sub-agent");
    expect(cmd.label).toBe("Background");
    expect(bash.label).toBe("Background");
    expect(sub.icon).not.toBe(cmd.icon);
  });
});
