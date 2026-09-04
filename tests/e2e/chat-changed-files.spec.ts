/**
 * chat-changed-files.spec.ts - the chip that says what the agent touched.
 *
 * The case: after a turn that wrote files there was nowhere to see them
 * together. You scrolled the transcript hunting for `write`/`edit` tool rows,
 * or you opened a terminal and ran `git status`, which answers a wider
 * question: everything dirty in the repo, whoever made it dirty.
 *
 * What is pinned here is the pair that makes the chip a SIGNAL and not
 * decoration: a topic whose turn wrote a file shows it, with the file in the
 * list and the line counts git computed; a topic whose turn only READ files
 * shows no chip at all. The second half is the one that rots silently, because
 * a chip that is always there costs nothing to render and tells you nothing.
 *
 * @covers CHAT-CHANGES-01
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { initGitRepo } from "./helpers/file-project";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** The session key of a topic, asked rather than guessed: its shape is the
 *  server's business and it has changed before. */
async function sessionKeyOf(request: import("@playwright/test").APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBe(true);
  const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string }> };
  const key = topics[topicId]?.sessionKey;
  if (!key) throw new Error(`topic ${topicId} has no sessionKey: nothing to seed into`);
  return key;
}

const REPO = `/tmp/e2e-changed-files-${Date.now()}`;

test.describe("I file che questa conversazione ha toccato", () => {
  const topics: string[] = [];

  test.beforeAll(() => {
    // A repo with one committed file: the edit below has something to be a
    // modification OF, and the writes have something to be new against.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/base.ts`, "one\ntwo\nthree\n");
    initGitRepo(REPO);
  });

  test.afterAll(async ({ request }) => {
    for (const id of topics) await deleteTopic(request, id).catch(() => {});
    rmSync(REPO, { recursive: true, force: true });
  });

  // The chat pane is opened through the pane store, not by clicking the
  // sidebar: a topic bound to a project sits under its project group, and this
  // spec is about the strip inside the chat, not about how you reach it.
  async function openChat(page: Page) {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 15_000 });
  }

  test("dopo un turno che ha scritto, il chip conta i file e il pannello li elenca", async ({ page, request }) => {
    const name = `changes-${Date.now()}`;
    const topic = await createTopic(request, name, { projectPath: REPO });
    topics.push(topic.id);
    await resetPaneStore(request, [topic.id]);

    // What the turn did on disk...
    writeFileSync(`${REPO}/nuovo.ts`, "alpha\nbeta\n");
    writeFileSync(`${REPO}/base.ts`, "one\ntwo\nthree\nfour\n");

    // ...and what the transcript says about it. The seeded tool calls carry no
    // typed detail, exactly like the rows of an older conversation: the path
    // comes out of the raw arguments.
    const sessionKey = await sessionKeyOf(request, topic.id);
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "fatto",
      toolCalls: [
        { id: "tc-1", name: "Write", args: { file_path: `${REPO}/nuovo.ts` }, status: "success" },
        { id: "tc-2", name: "Edit", args: { file_path: `${REPO}/base.ts` }, status: "success" },
      ],
    });

    await openChat(page);

    const chip = page.getByTestId("chat-changes-chip");
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText("2");

    await chip.click();
    const rows = page.getByTestId("chat-changes-row");
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId("chat-changes-list")).toContainText("nuovo.ts");
    // The counts are git's, and they are the topic's own: two new lines in the
    // created file, one added in the edited one.
    await expect(rows.filter({ hasText: "nuovo.ts" })).toContainText("+2");
    await expect(rows.filter({ hasText: "base.ts" })).toContainText("+1");
  });

  test("una conversazione che ha solo letto non mostra il chip", async ({ page, request }) => {
    const name = `no-changes-${Date.now()}`;
    const topic = await createTopic(request, name, { projectPath: REPO });
    topics.push(topic.id);
    await resetPaneStore(request, [topic.id]);

    await seedMessage(request, {
      sessionKey: await sessionKeyOf(request, topic.id),
      role: "assistant",
      content: "ho guardato",
      toolCalls: [
        { id: "tc-3", name: "Read", args: { file_path: `${REPO}/base.ts` }, status: "success" },
        { id: "tc-4", name: "Bash", args: { command: "ls" }, status: "success" },
      ],
    });

    await openChat(page);
    // The transcript is up, so the strip has had its chance to appear.
    await expect(page.getByText("ho guardato").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-changes-chip")).toHaveCount(0);
  });
});
