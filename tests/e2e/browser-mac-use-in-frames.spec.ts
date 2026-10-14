import { test, expect } from "@playwright/test";
import { INSTALL_USE_HOOK } from "../../client/src/lib/shell/paneViewport";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The Mac's use hook in a real engine.
 *
 * The native pane evaluates INSTALL_USE_HOOK in its WKWebView, and the Mac
 * takes a shared page back when the count moves (NATIVE-HOST-04). Before,
 * typing in an editor that lives in a frame never moved it: the page stayed
 * laid out for the iPad under the hands of the person at the Mac. The unit
 * test drives fake windows; this one proves what only an engine can: that a
 * real click or key in a frame of the same origin reaches the hook, a frame
 * added after the hook included, and that a frame of another origin does not
 * break it. Playwright's WebKit is the engine of the WKWebView.
 *
 * @covers NATIVE-HOST-04
 */
test("the Mac's use hook counts real input in same-origin frames, and a foreign frame does not break it", async ({ page }) => {
  await page.goto(`${E2E_BASE}/api/version`);
  // setContent writes into this document, so the srcdoc frames share its origin.
  // A data: frame has an opaque origin: the page cannot reach into it.
  await page.setContent(
    '<body style="margin:0">' +
      '<iframe id="editor" srcdoc="<textarea id=t></textarea>" style="width:320px;height:120px"></iframe>' +
      '<iframe id="foreign" src="data:text/html,<p>foreign</p>" style="width:320px;height:120px"></iframe>' +
      "</body>",
  );
  await page.frameLocator("#editor").locator("#t").waitFor();
  await page.evaluate((hook) => { new Function(hook)(); }, INSTALL_USE_HOOK);
  const count = () => page.evaluate(() => (window as unknown as { __topicsLocalUse?: number }).__topicsLocalUse ?? -1);
  expect(await count()).toBe(0);

  // A click and two keys in the editor's frame: three gestures of the person at the Mac.
  await page.frameLocator("#editor").locator("#t").click();
  await page.keyboard.type("ab");
  expect(await count(), "input in a same-origin frame did not reach the hook").toBe(3);

  // A frame that arrives after the hook, as an editor that mounts late, still
  // loading an image: its load event has not fired. The pane's next poll (the
  // hook runs again every 120 ms) is what hooks it.
  await page.route("**/never-loads.png", () => { /* never answered: the frame never finishes loading */ });
  await page.evaluate((src) => {
    const late = document.createElement("iframe");
    late.id = "late";
    late.srcdoc = `<input id=i><img src="${src}">`;
    document.body.appendChild(late);
  }, `${E2E_BASE}/never-loads.png`);
  await page.frameLocator("#late").locator("#i").waitFor();
  expect(await page.evaluate(() => (document.getElementById("late") as HTMLIFrameElement).contentDocument?.readyState)).not.toBe("complete");
  await page.evaluate((hook) => { new Function(hook)(); }, INSTALL_USE_HOOK);
  await page.frameLocator("#late").locator("#i").click();
  expect(await count(), "a frame still loading did not get the hook from the next poll").toBe(4);

  // The page itself still counts, with the foreign frame on it.
  await page.mouse.click(700, 60);
  expect(await count()).toBe(5);
});
