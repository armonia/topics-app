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
import { clipDiConsegna } from "./helpers/clip";
import { beat, didascalia } from "./helpers/evidence";

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
    const rows = page.getByTestId("changed-file-row");
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
  /**
   * WHERE the strip hangs, which is the half a screenshot cannot prove: it is
   * part of the bottom block now, above the composer and on its column, not in
   * the chrome above the tabs. Two topics in the same window, one that wrote
   * and one that only read, so the silence is measured against a composer that
   * does not move. Neither topic is bound to a worktree, so the strip names
   * no branch, and there is no terminal action to find.
   */
  test("la barretta sta SOPRA il composer, senza terminale ne' branch, e il topic che non ha scritto non la mostra", async ({ request }) => {
    // Two mounted transcripts, a dedicated browser and three read beats: the
    // 30s default is the suite's, not this test's.
    test.setTimeout(120_000);

    const stamp = Date.now();
    const written = await createTopic(request, `strip-written-${stamp}`);
    const readOnly = await createTopic(request, `strip-read-${stamp}`);
    topics.push(written.id, readOnly.id);

    await seedMessage(request, {
      sessionKey: await sessionKeyOf(request, written.id),
      role: "assistant",
      content: "ho scritto due file",
      toolCalls: [
        { id: `w1-${stamp}`, name: "Write", args: { file_path: `${WORK_DIR}/nuovo.ts` }, status: "success" },
        { id: `w2-${stamp}`, name: "Edit", args: { file_path: `${WORK_DIR}/base.ts` }, status: "success" },
      ],
    });
    await seedMessage(request, {
      sessionKey: await sessionKeyOf(request, readOnly.id),
      role: "assistant",
      content: "ho solo guardato",
      toolCalls: [
        { id: `r1-${stamp}`, name: "Read", args: { file_path: `${WORK_DIR}/base.ts` }, status: "success" },
      ],
    });
    await resetPaneStore(request, [written.id, readOnly.id]);

    /** The composer of ONE topic. Both chats stay MOUNTED behind the tabs, so
     *  the bare testid resolves to two textareas: the accessible name carries
     *  the topic's name and tells them apart. */
    const composerOf = (p: Page, name: string) =>
      p.getByRole("textbox", { name: new RegExp(`Message input for ${name}`) });

    async function boxOf(locator: ReturnType<Page["locator"]>): Promise<{ top: number; bottom: number; left: number; right: number }> {
      const box = await locator.boundingBox();
      expect(box, "the element has to be on screen to be measured").not.toBeNull();
      return { top: box!.y, bottom: box!.y + box!.height, left: box!.x, right: box!.x + box!.width };
    }

    const clip = await clipDiConsegna({
      nome: "changed-files-strip",
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 1280, height: 680 },
        reducedMotion: "reduce",
      },
      prologo: async (p) => {
        await p.goto("/");
        await p.getByTestId(`pane-tab-${written.id}`).click();
        await expect(p.getByTestId("chat-changes-chip")).toBeVisible({ timeout: 20000 });
      },
      scena: async (p) => {
        await p.goto("/");
        await p.getByTestId(`pane-tab-${written.id}`).click();

        // FIRST STATE: the topic that wrote. The strip is INSIDE the bottom
        // block of its chat (the `filter` is the containment assertion: one
        // input area holds the strip) and sits above the textarea, on the
        // composer's column.
        const strip = p.getByTestId("chat-changes-strip");
        await expect(strip).toBeVisible({ timeout: 20000 });
        await didascalia(p, "Un topic che ha scritto: la barretta sopra il composer");
        const inputArea = p.getByTestId("chat-input-area").filter({ has: strip });
        await expect(inputArea).toHaveCount(1);
        const composer = composerOf(p, `strip-written-${stamp}`);
        await expect(composer).toBeVisible();
        const stripBox = await boxOf(strip);
        const composerBox = await boxOf(composer);
        const areaBox = await boxOf(inputArea);
        expect(stripBox.bottom).toBeLessThanOrEqual(composerBox.top + 1);
        expect(stripBox.top).toBeGreaterThanOrEqual(areaBox.top - 1);
        expect(stripBox.left).toBeGreaterThanOrEqual(areaBox.left - 1);
        expect(stripBox.right).toBeLessThanOrEqual(areaBox.right + 1);

        // What is NOT there: the terminal action is gone for good, and a topic
        // that is not bound to a worktree names no branch even though the
        // count is up. `toHaveCount(0)` counts hidden nodes too, so the second
        // mounted chat cannot hide either.
        await expect(p.getByTestId("chat-changes-terminal")).toHaveCount(0);
        await expect(p.getByTestId("chat-changes-branch")).toHaveCount(0);
        await beat(p, 1200);

        // The list opens from down there, and the rows are the topic's files.
        await p.getByTestId("chat-changes-chip").click();
        await expect(p.getByTestId("changed-file-row")).toHaveCount(2);
        await didascalia(p, "Il chip apre l'elenco dei file di QUESTO topic");
        await beat(p, 1600);

        // SECOND STATE: a topic that only read. No strip in ITS bottom block,
        // and its composer is not pushed up by an empty band. Scoped to that
        // chat's input area on purpose: the chat that wrote stays mounted
        // behind its tab, strip included, so a bare count would find it.
        await p.getByTestId(`pane-tab-${readOnly.id}`).click();
        await expect(p.getByText("ho solo guardato").first()).toBeVisible({ timeout: 20000 });
        const areaAlone = p.getByTestId("chat-input-area").filter({ has: composerOf(p, `strip-read-${stamp}`) });
        await expect(areaAlone).toHaveCount(1);
        await expect(areaAlone.getByTestId("chat-changes-strip")).toHaveCount(0);
        await expect(p.getByTestId("chat-changes-strip")).toBeHidden();
        const composerAlone = await boxOf(composerOf(p, `strip-read-${stamp}`));
        expect(composerAlone.bottom).toBeGreaterThanOrEqual(composerBox.bottom - 1);
        await didascalia(p, "Un topic che non ha scritto: nessuna barretta, nessuno spazio vuoto");
        await beat(p, 1600);
      },
    });

    if (clip) console.log(`clip: ${clip.path} (${clip.durataMs} ms)`);
  });
});
