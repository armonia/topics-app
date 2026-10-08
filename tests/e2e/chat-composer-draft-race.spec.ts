/**
 * WHAT IS TYPED AS A CHAT OPENS IS WHAT GETS SENT (CHAT-COMPOSER-02).
 *
 * 08/10, a WebKit run on a loaded Mac (load 29): `fill` and Enter in a chat
 * that had just opened, and nothing left of it. No bubble, no POST /api/chat,
 * an empty composer for thirty seconds. The composer's text lived in
 * ChatPane's state, read from the saved draft when the pane mounted, and an
 * effect on the topic's id read the draft AGAIN and set it. A keystroke that
 * lands before that effect is overwritten by the draft saved before it, empty
 * for a new chat, and the Enter after it finds an empty field and returns
 * without a word.
 *
 * WHY THE KEYSTROKE IS TYPED INSIDE THE COMMIT. Measured on this Mac (08/10):
 * both ways of opening below commit the composer in a synchronous render,
 * whose effects run in the same task, so no keystroke from outside lands
 * before them. On a loaded machine the composer can commit in a scheduled
 * render instead, whose effects wait for a later task, and a keystroke that
 * arrives in between is the one that run lost. The test types in the commit
 * that first shows the composer, before that commit's effects: the order of
 * that run, on every run. React is observed through the DevTools hook, which
 * the production bundle calls on every commit too
 * (`helpers/react-commit-probe.ts` does the same); no code of the app is
 * compiled in for the test. Enter is Playwright's.
 *
 * Two ways a chat opens: with the page (the run that lost its message), and on
 * a click on the tab of a chat not shown yet, whose pane mounts there.
 *
 * @covers CHAT-COMPOSER-02
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { installFakeCli } from "./helpers/fake-claude-cli";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";

hermetic(test);
test.use({ video: "on" });

const STAMP = Date.now();

let project = "";
const topicIds: string[] = [];
let removeCli: (() => void) | null = null;

test.afterEach(async ({ request }) => {
  removeCli?.();
  removeCli = null;
  for (const id of topicIds.splice(0)) await deleteTopic(request, id).catch(() => {});
  if (project) removeTmpDir(project);
  project = "";
});

interface TypedInput {
  /** The chat whose composer gets it, by the name its field is labelled with. */
  name: string;
  text: string;
}

interface TypistWindow {
  __typist: { armed: TypedInput | null };
}

/**
 * Types into the armed chat's composer in the commit that first shows it,
 * before that commit's effects, armed from the page's first load or later
 * (`armTypist`). A real input event, with the value set the way the browser
 * sets it, so React reads it as a typedInput. Disarms itself.
 */
async function typeAsComposerAppears(page: Page, first: TypedInput | null): Promise<void> {
  await page.addInitScript((armed: TypedInput | null) => {
    const typist = { armed };
    (window as unknown as TypistWindow).__typist = typist;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const renderers = new Map<number, unknown>();
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: unknown) {
        const id = renderers.size + 1;
        renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot() {
        const target = typist.armed;
        if (!target) return;
        const field = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea[data-testid="chat-message-input"]'))
          .find((t) => (t.getAttribute("aria-label") ?? "").endsWith(target.name));
        if (!field) return;
        typist.armed = null;
        setValue.call(field, target.text);
        field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: target.text }));
      },
    };
  }, first);
}

/** Arms the typist again, for a composer that appears later in the same page. */
const armTypist = (page: Page, next: TypedInput) =>
  page.evaluate((armed) => {
    (window as unknown as TypistWindow).__typist.armed = armed;
  }, next);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const composer = (page: Page, name: string): Locator =>
  page.getByRole("textbox", { name: new RegExp(`(Campo del messaggio per|Message input for) ${escape(name)}$`) });

/** A chat of the scratch project, on the claude-code engine the fake CLI stands in for. */
async function projectChat(request: APIRequestContext, name: string): Promise<string> {
  const id = (await createTopic(request, name, { projectPath: project, provider: "claude-code" })).id;
  topicIds.push(id);
  return id;
}

/** The CLI got the message: a line on its stdin carries the text. */
const cliGot = (logPath: string, text: string) => () =>
  existsSync(logPath) && readFileSync(logPath, "utf8").split("\n").some((l) => l.includes('"event":"stdin"') && l.includes(text));

/** What was typed is still there, Enter sends it, and it reaches the transcript and the engine. */
async function sendWhatWasTyped(page: Page, typedInput: TypedInput, cliLog: string): Promise<void> {
  const field = composer(page, typedInput.name);
  await expect(field, "what was typed as the chat opened is still in the composer").toHaveValue(typedInput.text, { timeout: 2_000 });
  await field.press("Enter");
  await expect(page.getByTestId("chat-message").filter({ hasText: typedInput.text }).first(), "the message is in the transcript").toBeVisible({ timeout: 10_000 });
  await expect.poll(cliGot(cliLog, typedInput.text), { timeout: 15_000, message: "the message reached the engine" }).toBe(true);
  await expect(field, "the composer empties once the message is sent").toHaveValue("");
}

/**
 * Two chats of a scratch project, open as tabs of its window with the first in
 * front, each with the text that will be typed into it. The fake CLI writes
 * down what it gets.
 */
async function projectWithTwoChats(request: APIRequestContext, label: string): Promise<{ first: TypedInput; second: TypedInput; cliLog: string }> {
  project = canonicalTmpDir(`e2e-draft-race-${label}`);
  mkdirSync(project, { recursive: true });
  const first = { name: `E2E draft race ${label} first ${STAMP}`, text: `typed into the first chat as it opened ${STAMP}` };
  const second = { name: `E2E draft race ${label} second ${STAMP}`, text: `typed into the second chat as it opened ${STAMP}` };
  const ids = [await projectChat(request, first.name), await projectChat(request, second.name)];
  const cliLog = join(project, "cli.ndjson");
  removeCli = installFakeCli(resolve(__dirname, "helpers/fake-claude-record-input.ts"), { FAKE_CLI_LOG: cliLog });
  await resetPaneStore(request, []);
  await seedProjectPane(request, project);
  await seedProjectInnerChats(request, project, ids);
  await waitForPaneStoreQuiet(request);
  return { first, second, cliLog };
}

test("what is typed into a chat's composer as the page opens the chat is what gets sent", async ({ page, request }, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "CHAT-COMPOSER-02" });
  const { first, cliLog } = await projectWithTwoChats(request, "page");
  await typeAsComposerAppears(page, first);
  await goToApp(page);
  await composer(page, first.name).waitFor({ state: "visible", timeout: 20_000 });
  await sendWhatWasTyped(page, first, cliLog);
});

test("what is typed into a chat's composer as a click on its tab opens the chat is what gets sent", async ({ page, request }, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "CHAT-COMPOSER-02" });
  const { first, second, cliLog } = await projectWithTwoChats(request, "tab");
  await typeAsComposerAppears(page, null);
  await goToApp(page);
  await composer(page, first.name).waitFor({ state: "visible", timeout: 20_000 });
  // The second chat's tab has never been shown: the click mounts its pane.
  await expect(composer(page, second.name), "the second chat is not mounted before its tab is clicked").toHaveCount(0);
  await armTypist(page, second);
  await page.getByRole("tab", { name: new RegExp(escape(second.name)) }).click();
  await composer(page, second.name).waitFor({ state: "visible", timeout: 10_000 });
  await sendWhatWasTyped(page, second, cliLog);
});
