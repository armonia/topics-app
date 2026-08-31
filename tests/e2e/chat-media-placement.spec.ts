import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * Where a picture lands, and what must NOT be readable.
 *
 * Reported from a real chat: «why does it attach screenshots at the end of the
 * chat? at most they should be in the middle, when it wants to show them...
 * also the url it then writes, MEDIA:/…/.topics/media/armonia-masonry.png».
 * Two things in one sentence, and only the second was a defect.
 *
 * THE DEFECT: the marker cleaning ran on `content`, but a message with a
 * timeline paints from `blocks`, and the block's text reached the screen
 * untouched. On the live row: two markers at the tail of block 57 of 58,
 * printed as prose under the answer.
 *
 * THE OTHER HALF was the design. Nobody attaches those images: the server FINDS
 * them, with a scan of the media folder by mtime, and staples them to the end of
 * the turn (`updateLastMessageWithMedia`). So «put them where the agent wanted
 * them» was not implementable — the agent had never said.
 *
 * The rule now is one rule with no special case: a marker is drawn WHERE IT IS
 * WRITTEN. What the server appends sits at the end of the last block and so
 * still comes out at the end; what an agent writes mid-answer comes out
 * mid-answer. This spec proves BOTH directions.
 *
 * @covers CHAT-MEDIA-01
 */
test.describe.serial("A picture sits where it is declared", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  // `~/` and not the real home: this repo is PUBLIC and a path carrying the
  // user name would be committed with it (`check:security`). The SHAPE is what
  // matters — it is the shape the server produces — the owner is not, and these
  // files do not exist anyway.
  const A = "~/.topics/media/e2e-media-a.png";
  const B = "~/.topics/media/e2e-media-b.png";

  test.beforeAll(async ({ request }) => {
    topicName = "Chat Media " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  /**
   * THE ON-SCREEN ORDER, one word per element: "text" or "media".
   *
   * It walks the tree and stops at the first of the two it meets, so it reads
   * the SEQUENCE and not a count — and the sequence is the proof: with a
   * trailing gallery the answer would come out text,text,text,media,media even
   * when the markers were written in between.
   */
  const readOrder = (el: Element): string[] => {
    const out: string[] = [];
    const walk = (n: Element) => {
      const id = n.getAttribute("data-testid") || "";
      if (id.startsWith("media-")) { out.push("media"); return; }
      if (n.classList.contains("prose")) { out.push("text"); return; }
      for (const c of Array.from(n.children)) walk(c);
    };
    walk(el);
    return out;
  };

  /** What the reader actually READS in the assistant bubble. */
  const proseOf = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="message-content-assistant"]').last().innerText();

  test("the marker the server appends is not readable, and stays at the end", async ({ page, request }) => {
    const tail = `Fatto, ecco le due viste.\nMEDIA:${A}\nMEDIA:${B}`;
    await seedMessage(request, { sessionKey, role: "user", content: "fammi vedere" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: tail,
      blocks: [{ kind: "text", text: tail }],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const bubble = page.locator('[data-testid="message-content-assistant"]').last();
    await expect(bubble).toBeVisible({ timeout: 10000 });

    // 1) THE MARKER IS NOT READABLE. This is the report, literally.
    const text = await proseOf(page);
    expect(text, `the marker reached the screen:\n${text}`).not.toContain("MEDIA:");
    expect(text).not.toContain(".topics/media");
    // The real prose is still there: the message was not truncated.
    expect(text).toContain("Fatto, ecco le due viste.");

    // 2) AND IT STAYS AT THE END: appended by the server, so last. That is not a
    //    fallback, it is the same rule — it sits where it is written, and there
    //    it is written last.
    //
    //    The MEDIA SLOT is what gets measured, not the pixel: this test's files
    //    do not exist on disk, so `MediaImage` ends in its error branch
    //    (`media-image-error`). It is still the right element — the place the
    //    picture occupies — and measuring it does not depend on a resource load,
    //    which in a test is noise.
    const order = await bubble.evaluate(readOrder);
    expect(order.filter((x) => x === "media").length).toBe(2);
    expect(order.indexOf("text")).toBeLessThan(order.indexOf("media"));
  });

  test("written MID-ANSWER, it comes out MID-ANSWER", async ({ page, request }) => {
    const between = `Prima era cosi':\nMEDIA:${A}\ne dopo la cura cosi':\nMEDIA:${B}\nLa differenza e' il velo.`;
    await seedMessage(request, { sessionKey, role: "user", content: "e adesso?" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: between,
      blocks: [{ kind: "text", text: between }],
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const bubble = page.locator('[data-testid="message-content-assistant"]').last();
    await expect(bubble).toBeVisible({ timeout: 10000 });

    const text = await proseOf(page);
    expect(text).not.toContain("MEDIA:");

    const order = await bubble.evaluate(readOrder);
    expect(order, `order read: ${order.join(" -> ")}`).toEqual(["text", "media", "text", "media", "text"]);
  });
});
