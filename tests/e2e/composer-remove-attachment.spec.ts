/**
 * Removing one attachment out of several must not SEND the message.
 *
 * The composer is a `<form onSubmit>`, and a `<button>` with no `type` inside a
 * form is a submit button. The little "x" on each attachment chip had no type,
 * so the browser treated a click on it as "submit the form from this button".
 *
 * Why the obvious round (one attachment, click its x) never showed it: the
 * click handler drops the file, React re-renders before the browser runs the
 * button's submit step, and the chip (button included) is already out of the
 * DOM. A button that has just left the form has no form owner, so nothing is
 * submitted. Measured on the unfixed build: zero `submit` events.
 *
 * With TWO attachments the chips are keyed by index, so removing the first one
 * keeps the first chip's DOM node alive (it now shows the second file) and the
 * clicked button is still inside the form when the submit step runs. Measured
 * on the unfixed build: one `submit` event with the x as submitter, then
 * `POST /api/upload` and `POST /api/chat`. The draft left with the wrong
 * attachment set while the user was only tidying the tray.
 *
 * Both chip flavours are covered, because they are two components: the
 * paperclip chip (ChatInput) and the image thumbnail (ImageThumbnail).
 *
 * @covers CHAT-COMPOSER-XBTN
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

hermetic(test);

// The smallest valid PNG (1x1). `isImageFile` routes it to the thumbnail chip.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// Two 1x1 PNGs that differ in colour: pasted images are re-encoded through a
// canvas, so only the pixel tells one resulting data URL from the other.
const RED_PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BLUE_PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

test.describe("the x on an attachment", () => {
  let topicId: string;
  let topicName: string;
  let firstTextFile: string;
  let secondTextFile: string;
  let firstPng: string;
  let secondPng: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Composer x " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    const dir = join(tmpdir(), `e2e-composer-x-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    firstTextFile = join(dir, "first-note.txt");
    secondTextFile = join(dir, "second-note.txt");
    writeFileSync(firstTextFile, "first attachment");
    writeFileSync(secondTextFile, "second attachment");
    firstPng = join(dir, "first.png");
    secondPng = join(dir, "second.png");
    writeFileSync(firstPng, PNG_1x1);
    writeFileSync(secondPng, PNG_1x1);
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  async function openComposer(page: Page, request: Parameters<typeof resetPaneStore>[0]): Promise<Locator> {
    await resetPaneStore(request, [topicId]);
    // Belt and braces: should the composer submit anyway, the turn must not
    // reach a real provider from the test server.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "data: [DONE]\n\n" });
    });
    await goToApp(page);
    await openTopic(page, topicName);
    const textarea = page.getByTestId("chat-message-input");
    await expect(textarea).toBeVisible({ timeout: 10000 });
    return textarea;
  }

  /**
   * Type, attach two files, click the x of the FIRST one.
   *
   * `handleSendMessage` clears the draft and the tray synchronously, before any
   * network call, so "the draft is still there and one chip remains" IS the
   * observation that nothing was sent. No negative window is needed: the
   * click's own dispatch already contains the re-render and the submit step.
   */
  async function removeFirstOfTwo(page: Page, textarea: Locator, files: [string, string]) {
    await textarea.fill("ciao");
    await page.locator('input[type="file"]').first().setInputFiles(files);
    const attachments = page.getByTestId("composer-attachment");
    await expect(attachments).toHaveCount(2);

    await attachments.first().locator("button").first().click();

    await expect(
      textarea,
      "removing an attachment submitted the composer: the draft was cleared (the send path empties it first)",
    ).toHaveValue("ciao");
    await expect(
      attachments,
      "removing one attachment must leave the other in the tray, not send it",
    ).toHaveCount(1);
  }

  test("paperclip chip: removes the first of two files and sends nothing", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    await removeFirstOfTwo(page, textarea, [firstTextFile, secondTextFile]);
    await expect(page.getByTestId("composer-attachment")).toContainText("second-note.txt");
  });

  test("image thumbnail: removes the first of two images and sends nothing", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    await removeFirstOfTwo(page, textarea, [firstPng, secondPng]);
    await expect(page.getByTestId("composer-attachment").locator("img")).toHaveAttribute("alt", "second.png");
  });

  /**
   * The third chip flavour: an image that arrived by PASTE, which the composer
   * keeps in its own `pendingImages` state with its own inline x. Same
   * index-keyed list, so the same first-of-two round applies. The two source
   * pixels differ in colour on purpose: the surviving thumbnail can then be
   * identified by its data URL, which proves the FIRST one is the one that
   * left.
   */
  test("pasted image: removes the first of two and sends nothing", async ({ page, request }) => {
    const textarea = await openComposer(page, request);
    await textarea.fill("ciao");

    await textarea.evaluate((el, pngs: string[]) => {
      const dt = new DataTransfer();
      for (const [i, b64] of pngs.entries()) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], `pasted-${i}.png`, { type: "image/png" }));
      }
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [RED_PNG_1x1, BLUE_PNG_1x1]);

    const attachments = page.getByTestId("composer-attachment");
    await expect(attachments).toHaveCount(2);
    const survivorSrc = await attachments.last().locator("img").getAttribute("src");

    await attachments.first().locator("button").first().click();

    await expect(
      textarea,
      "removing a pasted image submitted the composer: the draft was cleared (the send path empties it first)",
    ).toHaveValue("ciao");
    await expect(attachments).toHaveCount(1);
    await expect(attachments.locator("img")).toHaveAttribute("src", survivorSrc!);
  });
});
