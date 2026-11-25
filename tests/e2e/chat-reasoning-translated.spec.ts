/**
 * THE REASONING SHOWS IN THE LANGUAGE OF THE CHAT.
 *
 * The model's reasoning summary comes in English even when the chat is in
 * Italian. A REAL server turn on the native runtime (provider Topics, fake
 * model: `helpers/fake-anthropic-api.ts`) reasons in English, three sentences;
 * the translator is a fake helper process at the boundary where the Swift helper
 * would sit (`tests/helpers/fake-reasoning-helper.mjs`), and everything else is
 * real: the segmentation, the cache table, the WebSocket frames, the row.
 *
 * The bar, in one run recorded on video (the .webm is the proof):
 *  - the row's text comes up in Italian, sentence by sentence;
 *  - the «Originale» control gives the English back and the translation again;
 *  - from the settled live turn to 1.5 s after the loader has gone, the row, the
 *    answer and the meta row move 0 px (the same ruler as `chat-turn-end-still`);
 *  - back in the chat later the row opens in Italian from what was saved.
 *
 * Set THINKING_PROOF_DIR to also copy the video and two screenshots (the row
 * translated and the same row in its original wording) out of the test folder.
 *
 * @covers REASONING-TRANSLATE-01
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic } from "./helpers/fake-anthropic-api";
import { framesOf, judge, nativeRuntime, nativeTopic, openChat, startSampler } from "./helpers/turn-end-sampler";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
// The video is the proof that the text comes up in Italian and that nothing moves at the end.
test.use({ video: VIDEO_ON, contextOptions: { reducedMotion: "no-preference" } });

const ANSWER = "ANSWER-TRANSLATED the answer after a reasoning in English.";
// Three sentences, English: the dictionary of the fake helper knows all three.
const REASONING_EN =
  "First I need to read the failing test and see what it expects. Then I will check the migration file for the new column. After that the answer can be written.";
const FAKE_HELPER = resolve(__dirname, "../helpers/fake-reasoning-helper.mjs");

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

test.describe("the reasoning shows in the language of the chat", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    // Long enough to read the row and press the control while it is live, then the answer.
    fake = await startFakeAnthropic({ translated: [{ thinking: REASONING_EN, afterThinkingMs: 4_000, text: ANSWER, holdMs: 20_000 }] });
    undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
    workspace = mkdtempSync(join(tmpdir(), "reasoning-translated-"));
    expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });
  });
  test.afterAll(async () => {
    await nativeRuntime({ on: false }).catch(() => {});
    undoFake?.();
    await fake?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test.beforeEach(async ({ request }) => {
    // The chat is in Italian; the translator is the fake helper.
    await request.put(`${E2E_BASE}/api/app-settings`, { data: { outputLanguage: "it" } });
    await request.post(`${E2E_BASE}/api/test/reasoning-helper`, { data: { path: FAKE_HELPER } });
  });
  test.afterEach(async ({ request }) => {
    await request.post(`${E2E_BASE}/api/test/reasoning-helper`, { data: { path: null } });
    await request.put(`${E2E_BASE}/api/app-settings`, { data: { outputLanguage: null } });
  });

  test("an English reasoning appears in Italian, the control gives the original back, and the end of the turn moves 0 px", async ({ page, request, chatPage }, testInfo) => {
    const topic = await nativeTopic(request, "reasoning-translated");
    await openChat(page, topic.name);
    await startSampler(page, "ANSWER-TRANSLATED");
    await chatPage.sendMessage("SCEN:translated go");

    const row = page.getByTestId("reasoning-row").last();
    const body = row.getByTestId("reasoning-body");
    const toggle = row.getByTestId("reasoning-original-toggle");
    await expect(body).toContainText("Prima devo leggere il test che fallisce", { timeout: 15_000 });
    await expect(body).toContainText("Poi controllerò il file di migrazione per la nuova colonna.");
    await expect(body).toContainText("Dopo di che si può scrivere la risposta.");
    await expect(body).not.toContainText("First I need");
    await expect(toggle).toBeVisible();

    const proofDir = process.env.THINKING_PROOF_DIR;
    if (proofDir) mkdirSync(proofDir, { recursive: true });
    const shot = async (name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      await row.screenshot({ path });
      await testInfo.attach(name, { path, contentType: "image/png" });
      if (proofDir) copyFileSync(path, join(proofDir, `${name}.png`));
    };
    await shot("riga-tradotta");
    await toggle.click();
    await expect(body).toContainText("First I need to read the failing test");
    await expect(body).not.toContainText("Prima devo leggere");
    await shot("riga-originale");
    await toggle.click();
    await expect(body).toContainText("Prima devo leggere il test che fallisce");

    const frames = await framesOf(page);
    judge("translated", frames, { row: true });
    await expect(page.getByTestId("chat-streaming-indicator")).toHaveCount(0);

    // Back in the chat later: the row opens in Italian again, from what was saved.
    await openChat(page, topic.name);
    await page.getByTestId("reasoning-row").last().getByRole("button", { name: /Thinking/ }).first().click();
    await expect(page.getByTestId("reasoning-body").last()).toContainText("Prima devo leggere il test che fallisce", { timeout: 15_000 });

    await deleteTopic(request, topic.id).catch(() => {});
    await page.close();
    // `saveAs` and not `path()`: with the browser on another machine the file is not local until it is saved.
    if (proofDir) await page.video()?.saveAs(join(proofDir, "thinking-tradotto.webm"));
  });
});
