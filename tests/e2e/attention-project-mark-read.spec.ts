/**
 * «MARK ALL AS READ» ON A PROJECT IS THE ONE SEEN DOOR (notifications-redesign,
 * tasks.md 6.2; ATTN-06).
 *
 * The project row's menu used to pick its chats from the `unread:*` frames and
 * call `POST /api/topics/:id/read` for each. Both went with the client that
 * read them: the menu now reads the attention store (a chat with something to
 * see: lit and unseen, unread, or a turn not seen) and sends those subjects to
 * `POST /api/attention/seen`, with the epochs it was showing.
 *
 * Driven through the real server: a chat of the project finishes a real turn
 * (the chat route, a fake CLI) while the window is behind another app, so it
 * is lit; the mark switches it off on the server, and a reload's
 * `attention:init` says so. No frame is written by the test.
 */
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { recordAttentionFrames, runChatTurn, stubBannersAndWindow } from "./helpers/attention";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectRow } from "./helpers/project-row";
import { topicSubject } from "../../shared/attention";

hermetic(test);

const MARK_ALL = /Segna tutto come letto|Mark all as read/;

test.describe("mark all as read on a project", () => {
  test.describe.configure({ timeout: 120_000 });
  let removeCli: (() => void) | null = null;
  test.beforeAll(() => { removeCli = installSlowTurnCli(); });
  test.afterAll(() => { removeCli?.(); removeCli = null; });

  test("a finished chat of the project goes dark through the seen door, and stays dark after a reload", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "ATTN-06" });
    const projectPath = canonicalTmpDir("e2e-mark-read-project");
    mkdirSync(projectPath, { recursive: true });
    const projectName = projectPath.split("/").pop()!;
    const chat = await createTopic(request, `Mark Read Chat ${Date.now()}`, { projectPath, provider: "claude-code" });
    const subject = topicSubject(chat.id);
    try {
      await resetPaneStore(request, []);
      await seedProjectPane(request, projectPath);
      await stubBannersAndWindow(page);
      const frames = recordAttentionFrames(page);
      await goToApp(page);
      const row = projectRow(page, projectName);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // The chat finishes while the window is behind another app: it is lit.
      await runChatTurn(request, chat.id, "a turn to read");
      await expect.poll(() => frames.rows().get(subject)?.lit ?? false, { timeout: 15_000, message: "the finished chat is not lit" }).toBe(true);

      // The project's menu offers the mark, and the mark is the seen door, for that chat.
      await row.click({ button: "right" });
      const menu = page.getByRole("menu");
      const mark = menu.getByRole("button", { name: MARK_ALL });
      await expect(mark).toBeVisible({ timeout: 10_000 });
      const seen = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/attention/seen");
      await mark.click();
      const body = (await seen).postDataJSON() as { items: { subject: string; epoch: number }[] };
      expect(body.items.map((i) => i.subject)).toEqual([subject]);
      await expect.poll(() => frames.rows().get(subject)?.lit ?? true, { timeout: 15_000, message: "the server kept the chat lit" }).toBe(false);

      // The server holds it: the snapshot of the reload's socket says seen,
      // and the menu has nothing left to offer.
      const initsBefore = frames.inits();
      await page.reload();
      await expect.poll(() => frames.inits(), { timeout: 15_000, message: "the reload's socket got no attention:init" }).toBeGreaterThan(initsBefore);
      expect(frames.rows().get(subject)?.lit ?? false, "the snapshot after the reload lights the chat again").toBe(false);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.click({ button: "right" });
      await expect(page.getByTestId("project-share")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("menu").getByRole("button", { name: MARK_ALL })).toHaveCount(0);
    } finally {
      await deleteTopic(request, chat.id);
      removeTmpDir(projectPath);
    }
  });
});
