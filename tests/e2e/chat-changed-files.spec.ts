/**
 * chat-changed-files.spec.ts - the chip that says what the agent touched.
 *
 * The case: after a turn that wrote files there was nowhere to see them
 * together. You scrolled the transcript hunting for `write`/`edit` tool rows,
 * or you opened a terminal and ran `git status`, which answers a wider
 * question: everything dirty in the repo, whoever made it dirty.
 *
 * What is pinned here is the pair that makes the chip a SIGNAL and not
 * decoration: a topic whose turn wrote files shows it, with those files in the
 * list; a topic whose turn only READ files shows no chip at all. The second
 * half is the one that rots silently, because a chip that is always there
 * costs nothing to render and tells you nothing.
 *
 * The LINE COUNTS are not pinned here but in
 * `tests/integration/topic-changes-route.test.ts`, on a real temporary
 * repository: they are the endpoint's answer, and asserting them through the
 * browser would test git twice and the chip once.
 *
 * @covers CHAT-CHANGES-01
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
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

/** Where the seeded tool calls claim to have written. The folder does not need
 *  to exist: outside a repository the panel answers from the tool calls alone,
 *  which is the degraded shape this spec walks through. */
const WORK_DIR = "/tmp/e2e-changed-files";

test.describe("I file che questa conversazione ha toccato", () => {
  const topics: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of topics) await deleteTopic(request, id).catch(() => {});
  });

  /** Open the topic's chat from the sidebar, alone in the pane store.
   *
   *  The reset is not hygiene: a pane left open by the previous test stays
   *  MOUNTED behind the current tab, strip included, and a `toHaveCount(0)`
   *  counts hidden nodes too. Without it the chip of the topic that wrote
   *  answers for the topic that only read. */
  async function openChat(page: Page, topicId: string, name: string) {
    await resetPaneStore(page.request, [topicId]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
  }

  test("dopo un turno che ha scritto, il chip conta i file e il pannello li elenca", async ({ page, request }) => {
    const name = `changes-${Date.now()}`;
    const topic = await createTopic(request, name);
    topics.push(topic.id);

    // The seeded tool calls carry no typed detail, exactly like the rows of an
    // older conversation: the path comes out of the raw arguments.
    await seedMessage(request, {
      sessionKey: await sessionKeyOf(request, topic.id),
      role: "assistant",
      content: "fatto",
      toolCalls: [
        { id: "tc-1", name: "Write", args: { file_path: `${WORK_DIR}/nuovo.ts` }, status: "success" },
        { id: "tc-2", name: "Edit", args: { file_path: `${WORK_DIR}/base.ts` }, status: "success" },
      ],
    });

    await openChat(page, topic.id, name);

    const chip = page.getByTestId("chat-changes-chip");
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText("2");

    await chip.click();
    const rows = page.getByTestId("chat-changes-row");
    await expect(rows).toHaveCount(2);
    const list = page.getByTestId("chat-changes-list");
    await expect(list).toContainText("nuovo.ts");
    await expect(list).toContainText("base.ts");
  });

  test("una conversazione che ha solo letto non mostra il chip", async ({ page, request }) => {
    const name = `no-changes-${Date.now()}`;
    const topic = await createTopic(request, name);
    topics.push(topic.id);

    await seedMessage(request, {
      sessionKey: await sessionKeyOf(request, topic.id),
      role: "assistant",
      content: "ho guardato",
      toolCalls: [
        { id: "tc-3", name: "Read", args: { file_path: `${WORK_DIR}/base.ts` }, status: "success" },
        { id: "tc-4", name: "Bash", args: { command: "ls" }, status: "success" },
      ],
    });

    await openChat(page, topic.id, name);
    // The transcript is up, so the strip has had its chance to appear.
    await expect(page.getByText("ho guardato").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-changes-chip")).toHaveCount(0);
  });
});
