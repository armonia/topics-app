import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { deflateSync } from "zlib";
import { expect } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });

const BASE = E2E_BASE;
// Served by /api/media: `${APP_DATA_DIR}/media/`, inside the test server's data dir.
const MEDIA_DIR = join(E2E_DATA_DIR, ".app-data", "media", "question-with-images");

/**
 * "A question about something visual carries its pictures, and the person
 *  chooses by looking."
 *
 * Four options, each with its own picture. Touching the picture picks the
 * option; the answer that reaches the agent is the option's TEXT. The pictures
 * open in the viewer the chat already has (the corner button opens it without
 * choosing). A picture still loading shows a placeholder, a missing one says so
 * and the option stays choosable. Run on desktop, tablet and phone widths.
 *
 * Behaviour: video on, the .webm is the proof. The pure parts have unit tests
 * (ask-user-images.test.ts, board-ask-routing.test.ts, topics-mcp-server.test.ts).
 *
 * @covers ASK-01
 */

/** A solid-colour PNG, built here so the suite does not depend on a fixture. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PROPOSALS = [
  { label: "Quiet", file: "quiet.png", color: [90, 130, 180] as [number, number, number] },
  { label: "Loud", file: "loud.png", color: [210, 70, 60] as [number, number, number] },
  { label: "Warm", file: "warm.png", color: [230, 170, 70] as [number, number, number] },
  { label: "Plain", file: "plain.png", color: [150, 150, 150] as [number, number, number] },
];

test.describe.serial("La domanda porta l'immagine", () => {
  test.setTimeout(120_000);
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    mkdirSync(MEDIA_DIR, { recursive: true });
    for (const p of PROPOSALS) writeFileSync(join(MEDIA_DIR, p.file), solidPng(240, 150, p.color));
    writeFileSync(join(MEDIA_DIR, "overview.png"), solidPng(480, 150, [60, 60, 70]));
    topicName = `qimg-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "the topic needs a session key").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  const SIZES = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "tablet", width: 768, height: 900 },
    { name: "phone", width: 375, height: 700 },
  ] as const;

  for (const size of SIZES) {
    test(`${size.name}: si sceglie toccando l'immagine, all'agente arriva il testo`, async ({ page, chatPage, request }) => {
      await resetPaneStore(request, [topicId]);
      const toolCallId = `toolu_img_${size.name}`;
      const question = "Quale delle quattro proposte?";
      const options = PROPOSALS.map((p) => ({ label: p.label, image: join(MEDIA_DIR, p.file) }));
      const questions = [{ question, header: "Design", images: [join(MEDIA_DIR, "overview.png")], options, multiSelect: false }];
      await seedMessage(request, { sessionKey, role: "user", content: "scegli la grafica" });
      await seedMessage(request, {
        sessionKey,
        role: "assistant",
        content: "Quattro proposte:",
        toolCalls: [{
          id: toolCallId,
          name: "mcp__topics__ask_user_question",
          args: { questions },
          status: "waiting_for_input",
          startedAt: Date.now() - 4_000,
          userInputSchema: { kind: "questions", questions },
        }],
      });
      // The bridge as the MCP subprocess runs it: legs until the person answers.
      const bridge = (async () => {
        for (let legs = 1; legs <= 200; legs++) {
          const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/ask-user`, {
            data: { questions, legMs: 800 }, ignoreHTTPSErrors: true, timeout: 60_000,
          });
          const body = (await r.json()) as { answers?: Record<string, string>; pending?: boolean };
          if (!body.pending) return body;
        }
        throw new Error("the bridge polled 200 times without an answer");
      })();

      await page.setViewportSize({ width: size.width, height: size.height });
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topicName));
      await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });

      const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
      await expect(form).toBeVisible({ timeout: 15_000 });
      // One picture for the question, one for each of the four options.
      await expect(form.getByTestId("ask-question-image")).toHaveCount(1);
      await expect(form.getByTestId("ask-option-image")).toHaveCount(4);
      // Loaded for real, not a broken square. The pictures load lazily: on a
      // phone the lower ones wait below the fold of the chat until they are
      // scrolled to, as a person does, so each is brought into view first.
      for (const img of await form.getByTestId("ask-option-image").all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).toBe(true);
      }
      await expect(form.getByTestId("ask-image-missing")).toHaveCount(0);

      // The picture opens in the viewer the chat already has, without choosing.
      await form.getByTestId("ask-question-image").click();
      const viewer = page.getByRole("dialog");
      await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await form.getByTestId("ask-option-image-zoom").nth(1).click();
      await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await expect(form.locator('input[type="radio"]:checked')).toHaveCount(0);

      // Accessibility: every picture has alternative text, the options are
      // reachable from the keyboard.
      for (const img of await form.locator("img").all()) {
        await expect(img).toHaveAttribute("alt", /.+/);
      }
      await page.addScriptTag({ path: resolve("node_modules/axe-core/axe.min.js") });
      const violations = await page.evaluate(async (selector) => {
        const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
        const result = await axe.run({ include: [[selector]] }, { runOnly: ["wcag2a", "wcag2aa"] });
        return result.violations.map(({ id }) => id);
      }, `[data-testid="tool-input-form-${toolCallId}"]`);
      expect(violations).toEqual([]);
      await form.locator('input[type="radio"]').first().focus();
      await page.keyboard.press("ArrowDown");
      await expect(form.locator('input[type="radio"][value="Loud"]')).toBeChecked();

      // Touching the picture picks the option.
      await form.getByTestId("ask-option-image").nth(2).click();
      await expect(form.locator('input[type="radio"][value="Warm"]')).toBeChecked();
      await form.getByRole("button", { name: /Invia/ }).click();

      const result = await bridge;
      expect(result.answers).toEqual({ [question]: "Warm" });
      // The answer is out: the server flips the call to running, the panel
      // closes and the row keeps the choice. That row is the last frame of
      // the clip.
      await expect(form).toBeHidden({ timeout: 10_000 });
      await expect(page.getByTestId(`tool-call-row-${toolCallId}`)).toContainText("Warm");
    });
  }

  test("un'immagine che non c'è: lo dice, e l'opzione si sceglie lo stesso", async ({ page, chatPage, request }) => {
    await resetPaneStore(request, [topicId]);
    const toolCallId = "toolu_img_missing";
    const question = "Quale?";
    const questions = [{
      question,
      header: "Scelta",
      options: [
        { label: "Presente", image: join(MEDIA_DIR, "quiet.png") },
        { label: "Mancante", image: join(MEDIA_DIR, "ghost.png") },
      ],
    }];
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "Scegli:",
      toolCalls: [{
        id: toolCallId, name: "mcp__topics__ask_user_question", args: { questions },
        status: "waiting_for_input", startedAt: Date.now() - 2_000,
        userInputSchema: { kind: "questions", questions },
      }],
    });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    const form = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
    await expect(form.getByTestId("ask-image-missing")).toHaveCount(1, { timeout: 15_000 });
    await form.locator('input[type="radio"][value="Mancante"]').check();
    await expect(form.locator('input[type="radio"][value="Mancante"]')).toBeChecked();
  });
});
