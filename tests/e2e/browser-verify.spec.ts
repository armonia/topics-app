import { test, expect } from "./fixtures/browser-v2.fixture";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** @covers BROWSER-CHAT-06 */
test("browser_verify reloads a file fixture and reports the new CSS value", async ({ page, request }) => {
  const source = readFileSync(resolve(__dirname, "fixtures/browser-verify-page.html"), "utf8");
  let background = "rgb(180, 20, 20)";
  const fixtureServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/change-css") {
      background = "rgb(0, 128, 0)";
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && req.url === "/fixture.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(source);
      return;
    }
    if (req.method === "GET" && req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(`#price { background-color: ${background}; color: white; padding: 12px; }`);
      return;
    }
    res.writeHead(404).end("missing fixture resource");
  });
  await new Promise<void>((done) => fixtureServer.listen(0, "127.0.0.1", done));
  const port = (fixtureServer.address() as AddressInfo).port;
  const fixtureUrl = `http://127.0.0.1:${port}/fixture.html`;
  const gateway = {
    "Content-Type": "application/json",
    "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token",
  };
  const topic = await createTopic(request, `E2E-BrowserVerify-${Date.now()}`);
  try {
    // `open` is not a bridged endpoint: the agent opens a page via the browsers route.
    const open = await request.post(`${E2E_BASE}/api/browsers/${topic.id}/agent/open`, {
      data: { url: fixtureUrl }, headers: { "Content-Type": "application/json" },
    });
    expect(open.ok()).toBe(true);
    expect((await open.json()).url).toBe(fixtureUrl);
    // The video shows the page as the agent found it, then what the agent got back.
    await page.goto(fixtureUrl);
    await expect(page.locator("#price")).toHaveCSS("background-color", "rgb(180, 20, 20)");

    await fetch(`http://127.0.0.1:${port}/change-css`, { method: "POST" });
    const verifyNew = await request.post(`${E2E_BASE}/api/topics/${topic.id}/browser/verify`, {
      data: { checks: [{ selector: "#price", text: "€ 12", visible: true, style: { "background-color": "rgb(0, 128, 0)" } }] },
      headers: gateway,
    });
    expect(verifyNew.ok()).toBe(true);
    const passed = await verifyNew.json();
    expect(passed.error).toBeUndefined();
    expect(passed.checks).toEqual([expect.objectContaining({ selector: "#price", status: "pass" })]);
    expect(passed.screenshot.bytes).toBeGreaterThan(100);
    expect(passed.consoleErrors).toEqual(expect.arrayContaining([expect.objectContaining({ text: "errore fixture dopo il reload" })]));
    expect(passed.failedRequests).toEqual(expect.arrayContaining([expect.objectContaining({ url: `${fixtureUrl.replace("fixture.html", "missing-after-reload.png")}`, status: 404 })]));
    const shot = readFileSync(passed.screenshot.path).toString("base64");
    await page.setContent(`<h1>browser_verify</h1><img alt="agent screenshot" src="data:image/jpeg;base64,${shot}" style="max-width:100%"><pre id="result"></pre>`);
    await page.locator("#result").evaluate((el, text) => { el.textContent = text; }, JSON.stringify(passed.checks, null, 2));
    await expect(page.locator("#result")).toContainText('"status": "pass"');

    const verifyOld = await request.post(`${E2E_BASE}/api/topics/${topic.id}/browser/verify`, {
      data: { checks: [{ selector: "#price", style: { "background-color": "rgb(180, 20, 20)" } }] },
      headers: gateway,
    });
    const failed = await verifyOld.json();
    expect(failed.checks).toEqual([
      expect.objectContaining({ selector: "#price", status: "fail", value: { style: { "background-color": "rgb(0, 128, 0)" } } }),
    ]);
    await page.locator("#result").evaluate((el, text) => { el.textContent += "\n" + text; }, JSON.stringify(failed.checks, null, 2));
    await expect(page.locator("#result")).toContainText('"status": "fail"');
  } finally {
    await request.delete(`${E2E_BASE}/api/browsers/${topic.id}`).catch(() => {});
    await deleteTopic(request, topic.id).catch(() => {});
    await new Promise<void>((done, reject) => {
      fixtureServer.close((error) => error ? reject(error) : done());
      fixtureServer.closeAllConnections();
    });
  }
});
