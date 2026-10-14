import { expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type ChatPage } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installReplayCli } from "./helpers/fake-claude-cli";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 180_000 });

/**
 * `/resume` LISTS THIS PROJECT'S CLAUDE CODE SESSIONS BORN OUTSIDE TOPICS AND
 * OPENS ONE AS A CHAT THAT CONTINUES IT (CMDUI-03).
 *
 * The transcripts are files under the test server's HOME, written the way the
 * CLI writes them, with their mtimes set by hand: «Menu utente» (a  allow-italian: fixture title
 * `custom-title`), one with only its `last-prompt`, one touched two minutes
 * ago (still running in a terminal), twenty-two old ones, one already held by
 * a chat and one in another project's folder. The CLI of the chat that
 * results is `fake-claude-replay.ts`, which writes its start arguments: «the
 * next turn starts with `--resume <id>`» is read there.
 *
 * @covers CMDUI-03
 */

const LOG = join(E2E_HOME, "fake-cli-resume.jsonl");
const PROJECT = canonicalTmpDir("e2e-resume-project");
const OTHER = canonicalTmpDir("e2e-resume-other");
const NOW = Date.now();
const MIN = 60_000;
const id = (n: number) => `5e550000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MENU = id(1);
const PROMPT_ONLY = id(2);
const LIVE = id(3);
const OWNED = id(4);
const ELSEWHERE = id(5);

function transcript(cwd: string, sessionId: string, mtimeMs: number, extra: Array<Record<string, unknown>> = []): void {
  const dir = join(E2E_HOME, ".claude", "projects", claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "feat/menu", version: "2.1.288" };
  const lines = [
    { ...base, type: "user", uuid: `${sessionId}-u`, timestamp: new Date(mtimeMs - 1000).toISOString(), message: { role: "user", content: `domanda di ${sessionId.slice(-4)}` } },
    { ...base, type: "assistant", uuid: `${sessionId}-a`, timestamp: new Date(mtimeMs).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `risposta-importata-${sessionId.slice(-4)}` }] } },
    ...extra,
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const picker = (page: Page) => page.getByTestId("resume-picker");
const rows = (page: Page) => picker(page).getByTestId("resume-row");

async function typeResume(chatPage: ChatPage, page: Page, text = "/resume") {
  await chatPage.messageInput.click();
  await chatPage.messageInput.fill(text);
  await page.keyboard.press("Escape");
  await chatPage.messageInput.press("Enter");
}

test.describe("/resume", () => {
  let topicId = "";
  const topicName = `resume-here-${NOW}`;
  let uninstall: (() => void) | null = null;
  const made: string[] = [];

  test.beforeAll(async ({ request }) => {
    rmSync(LOG, { force: true });
    uninstall = installReplayCli(LOG);
    for (const dir of [PROJECT, OTHER]) mkdirSync(dir, { recursive: true });
    transcript(PROJECT, MENU, NOW - 30 * MIN, [{ type: "custom-title", customTitle: "Menu utente", sessionId: MENU }]);
    transcript(PROJECT, PROMPT_ONLY, NOW - 40 * MIN, [{ type: "last-prompt", lastPrompt: "sistema la barra della settimana", sessionId: PROMPT_ONLY }]);
    transcript(PROJECT, LIVE, NOW - 2 * MIN, [{ type: "ai-title", aiTitle: "Sessione ancora viva", sessionId: LIVE }]);
    for (let i = 0; i < 22; i++) transcript(PROJECT, id(100 + i), NOW - (24 * 60 + i) * MIN, [{ type: "ai-title", aiTitle: `Vecchia ${i}`, sessionId: id(100 + i) }]);
    transcript(PROJECT, OWNED, NOW - 10 * MIN, [{ type: "custom-title", customTitle: "Già adottata", sessionId: OWNED }]);
    transcript(OTHER, ELSEWHERE, NOW - 1 * MIN, [{ type: "custom-title", customTitle: "Di un altro progetto", sessionId: ELSEWHERE }]);
    // One is held by a chat already.
    const owned = await request.post(`${E2E_BASE}/api/topics/adopt-claude`, { data: { sessionId: OWNED } });
    expect(owned.ok()).toBe(true);
    made.push(((await owned.json()) as { id: string }).id);
    topicId = (await createTopic(request, topicName, { provider: "claude-code", projectPath: PROJECT })).id;
    made.push(topicId);
  });

  test.afterAll(async ({ request }) => {
    uninstall?.();
    for (const t of made) await deleteTopic(request, t);
    for (const cwd of [PROJECT, OTHER]) rmSync(join(E2E_HOME, ".claude", "projects", claudeProjectDirName(cwd)), { recursive: true, force: true });
    removeTmpDir(PROJECT);
    removeTmpDir(OTHER);
  });

  test.beforeEach(async ({ page, request, chatPage }) => {
    // A chat of a project lives in the project's window: that window is
    // seeded open with this chat as its only tab, the way the UI leaves it.
    await resetPaneStore(request, []);
    await resetProjectPanes(request, PROJECT);
    await seedProjectPane(request, PROJECT);
    await seedProjectInnerChats(request, PROJECT, [topicId]);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  });

  test("lists the project's sessions newest first, 20 at a time, filters, and adopts one that continues with --resume", async ({ page, request, chatPage }) => {
    await typeResume(chatPage, page);
    await expect(picker(page)).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(20, { timeout: 15_000 });
    const titles = await rows(page).getByTestId("resume-row-title").allTextContents();
    expect(titles.slice(0, 3)).toEqual(["Sessione ancora viva", "Menu utente", "sistema la barra della settimana"]);
    expect(titles).not.toContain("Già adottata");
    expect(titles).not.toContain("Di un altro progetto");
    await expect(rows(page).first().getByTestId("resume-row-active")).toHaveText("attiva adesso");
    await expect(rows(page).first()).toContainText("feat/menu");

    // «Load older» brings the other five by itself once its row comes into view (LIST-PAGE-01), with one request.
    const older: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/resumable-sessions?before=")) older.push(r.url()); });
    await picker(page).getByTestId("resume-load-more").scrollIntoViewIfNeeded();
    await expect(rows(page)).toHaveCount(25, { timeout: 15_000 });
    await expect(picker(page).getByTestId("resume-load-more")).toHaveCount(0);
    expect(older).toHaveLength(1);

    // The word after `/resume ` filters on title and branch.
    // Every fixture's branch is `feat/menu`, so the word is one of a title only.
    await chatPage.messageInput.click();
    await chatPage.messageInput.press("End");
    await chatPage.messageInput.pressSequentially("utente");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().getByTestId("resume-row-title")).toHaveText("Menu utente");

    // Enter adopts it: a new chat with the imported history, opened.
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(`risposta-importata-${MENU.slice(-4)}`).first()).toBeVisible({ timeout: 20_000 });
    const adopted = await request.get(`${E2E_BASE}/api/topics`).then((r) => r.json() as Promise<{ topics: Record<string, { id: string; name: string }> }>);
    const chat = Object.values(adopted.topics).find((t) => t.name === "Menu utente");
    expect(chat, "a chat named after the session").toBeTruthy();
    made.push(chat!.id);

    // The next turn continues the same session.
    const field = page.getByRole("textbox", { name: "Campo del messaggio per Menu utente" });
    await field.click();
    await field.fill("continuo da qui");
    await field.press("Enter");
    await expect.poll(() => {
      if (!existsSync(LOG)) return "";
      const starts = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; argv?: string[] }).filter((l) => l.event === "start");
      const argv = starts.at(-1)?.argv ?? [];
      const at = argv.indexOf("--resume");
      return at >= 0 ? argv[at + 1] : "";
    }, { timeout: 40_000 }).toBe(MENU);
  });

  test("a session still running in a terminal asks first", async ({ page, chatPage }) => {
    await typeResume(chatPage, page);
    await expect(rows(page).first()).toHaveAttribute("data-session-id", LIVE, { timeout: 15_000 });
    await rows(page).first().click();
    const dialog = page.getByRole("dialog").filter({ hasText: "È ancora attiva in un terminale" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: /Annulla/ }).click();
    await expect(dialog).toHaveCount(0);
    // Nothing was adopted: the list is still there, the row too.
    await expect(rows(page).first()).toHaveAttribute("data-session-id", LIVE);
  });

  test("a chat with no project answers with a card, and nothing reaches the CLI", async ({ page, request, chatPage }) => {
    const name = `resume-noproject-${Date.now()}`;
    const t = await createTopic(request, name, { provider: "claude-code" });
    made.push(t.id);
    await resetPaneStore(request, [t.id]);
    await resetProjectPanes(request, PROJECT);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    const before = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    await typeResume(chatPage, page);
    const card = page.getByTestId("chat-command-result");
    await expect(card).toContainText("/resume elenca le sessioni Claude Code di un progetto", { timeout: 10_000 });
    expect(existsSync(LOG) ? readFileSync(LOG, "utf8") : "").toBe(before);
  });
});
