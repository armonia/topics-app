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
 * THE DIFF INSIDE THE STRIP (CHGSET-03). On a repository the strip draws the
 * topic's changeset with the board's own panel: a row expands in place into
 * its `-`/`+` lines, a rewritten picture into its Before/After pair, and no
 * editor pane opens. Walked here on a real throwaway repository, on WebKit.
 *
 * @covers CHAT-CHANGES-01, CHGSET-03
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
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";
import { join } from "path";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

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
const WORK_DIR = join(canonicalTmpRoot(), "e2e-changed-files");

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
    // `clipDiConsegna` launches its own Chromium: under the webkit project it
    // would be the Chromium this Mac refuses, and the chromium project runs it.
    test.skip(test.info().project.name === "webkit", "the clip launches Chromium: the chromium project runs it");

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
      p.getByRole("textbox", { name: new RegExp(`Campo del messaggio per ${name}`) });

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

/** Two 1x1 pictures, red then blue: the Before and the After of a rewritten PNG. */
const RED_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63b82327070002f2011973440bcb0000000049454e44ae426082", "hex");
const BLUE_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c639093bb030001760119dbebbf3b0000000049454e44ae426082", "hex");

test.describe("the strip opens the chat's changeset with the board's diff panel", () => {
  const topics: string[] = [];
  const repos: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of topics) await deleteTopic(request, id).catch(() => {});
    for (const dir of repos) removeTmpDir(dir);
  });

  /** A throwaway repository with `files` committed, in a folder of its own for this run. */
  function makeRepo(label: string, files: Record<string, string | Buffer>): { dir: string; git: (...args: string[]) => string } {
    const dir = join(canonicalTmpRoot(), `e2e-chgset-${label}-${Date.now()}`);
    repos.push(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    mkdirSync(dir, { recursive: true });
    git("init", "-q", "-b", "main");
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    return { dir, git };
  }

  /** A topic on `dir` whose conversation wrote `writes` (repo-relative), opened by permalink. */
  async function chatOn(page: Page, dir: string, writes: Array<{ path: string; tool: "Write" | "Edit" }>): Promise<string> {
    const topic = await createTopic(page.request, `chgset-${Date.now()}`, { projectPath: dir });
    topics.push(topic.id);
    await seedMessage(page.request, {
      sessionKey: await sessionKeyOf(page.request, topic.id),
      role: "assistant",
      content: "fatto",
      toolCalls: writes.map((w, i) => ({ id: `w${i}-${topic.id}`, name: w.tool, args: { file_path: join(dir, w.path) }, status: "success" })),
    });
    // By permalink: a topic bound to a project has no top-level sidebar row.
    await resetPaneStore(page.request, [topic.id]);
    const opened = await page.goto(`/tab/chat/${topic.id}`);
    expect(opened?.status()).toBe(200);
    return topic.id;
  }

  test("two files changed: two rows, and a row opens its own -/+ lines inside the strip", async ({ page }) => {
    test.setTimeout(90_000);
    const { dir } = makeRepo("two", { "a.txt": "uno\ndue\n" });
    writeFileSync(join(dir, "a.txt"), "uno\nDUE\n");
    writeFileSync(join(dir, "b.txt"), "nuovo\n");
    // Somebody else's dirt in the same checkout: not this chat's.
    writeFileSync(join(dir, "c.txt"), "altrui\n");
    await chatOn(page, dir, [{ path: "a.txt", tool: "Edit" }, { path: "b.txt", tool: "Write" }]);

    const chip = page.getByTestId("chat-changes-chip");
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toContainText("2");
    await beat(page, 600);
    await chip.click();

    const diff = page.getByTestId("chat-changes-diff");
    const files = diff.getByTestId("diff-file");
    await expect(files).toHaveCount(2, { timeout: 15_000 });
    await expect(files.nth(0)).toHaveAttribute("data-path", /^(a|b)\.txt$/);
    await expect(diff.locator('[data-testid="diff-file"][data-path="c.txt"]')).toHaveCount(0);
    await beat(page, 800);

    const a = diff.locator('[data-testid="diff-file"][data-path="a.txt"]');
    await a.getByRole("button", { name: /a\.txt/ }).click();
    await expect(a).toContainText("-due");
    await expect(a).toContainText("+DUE");
    // b.txt stays closed: the click opened ITS file, not every file.
    await expect(diff.locator('[data-testid="diff-file"][data-path="b.txt"]')).not.toContainText("+nuovo");
    // In the strip, not in the editor.
    await expect(page.getByTestId("file-pane")).toHaveCount(0);
    await beat(page, 1500);
  });

  test("a rewritten picture opens as its Before/After pair", async ({ page }) => {
    test.setTimeout(90_000);
    const { dir, git } = makeRepo("png", { "docs/shot.png": RED_PNG });
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "docs/shot.png"), BLUE_PNG);
    await chatOn(page, dir, [{ path: "docs/shot.png", tool: "Write" }]);

    await page.getByTestId("chat-changes-chip").click({ timeout: 20_000 });
    const file = page.getByTestId("chat-changes-diff").locator('[data-testid="diff-file"][data-path="docs/shot.png"]');
    await file.getByRole("button", { name: /shot\.png/ }).click();
    const before = file.getByTestId("diff-image-before");
    const after = file.getByTestId("diff-image-after");
    await expect(before).toHaveAttribute("src", new RegExp(`/api/topics/[^/]+/changes/diff\\?file=docs%2Fshot\\.png&blob=${head}`));
    await expect(after).toHaveAttribute("src", /blob=worktree/);
    // Both pictures actually arrived: a broken <img> has no natural width.
    await expect.poll(() => before.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect.poll(() => after.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await beat(page, 1200);
  });
});
