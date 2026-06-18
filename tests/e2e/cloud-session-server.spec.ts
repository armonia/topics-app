/**
 * Server-side end-to-end verification for the cloud-session ↔ project work.
 *
 * Runs against the real test server (:13334), which executes the actual server
 * code — no client build needed. Captures server→client broadcasts via a real
 * WebSocket opened from a browser page.
 *
 * Covers:
 *  - "open project <name>" from a cloud session resolves the user's REAL
 *    Topics project by name and emits pane:focus-suggest (open + nest).
 *  - adopting a gateway session opens it as a first-class interactive,
 *    openclaw-backed Topics chat (idempotent).
 */
import { test, expect } from "./fixtures/test-fixtures";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mkdirSync, rmSync } from "fs";

const BASE = "http://localhost:13334";

/** Open a passive WS to the test server inside the page and collect frames. */
async function captureFrames(page: import("@playwright/test").Page) {
  await page.goto("about:blank");
  await page.evaluate((base) => {
    (window as any).__frames = [];
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    ws.onmessage = (e) => {
      try { (window as any).__frames.push(JSON.parse(e.data as string)); } catch { /* non-JSON */ }
    };
    return new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
  }, BASE);
}

function frames(page: import("@playwright/test").Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__frames || []);
}

test.describe("cloud session ↔ project (server e2e)", () => {
  test("'/project open <name>' resolves a real Topics project by name and emits pane:focus-suggest", async ({
    page,
    request,
  }) => {
    const ts = Date.now().toString(36);
    const projectDir = `/tmp/e2e-cloud-proj-${ts}`;
    const projectName = `e2e-cloud-proj-${ts}`;
    mkdirSync(projectDir, { recursive: true });

    // Anchor topic registers projectDir as a project Topics knows about.
    const anchor = await createTopic(request, `Anchor-${ts}`, { projectPath: projectDir });
    // The "cloud session" that opens the project BY NAME.
    const cloud = await createTopic(request, `CloudSession-${ts}`);
    const cloudSessionKey = `topic:${cloud.id.slice(0, 8)}`;

    await captureFrames(page);

    const res = await request.post(`${BASE}/api/command`, {
      data: { command: "project", sessionKey: cloudSessionKey, args: { sub: "open", value: projectName } },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // resolveProjectRef matched the bare NAME to the real project path.
    expect(body.path).toBe(projectDir);

    // bindTopicToProject persisted projectPath on the cloud session.
    const topicsBody = await (await request.get(`${BASE}/api/topics`)).json();
    expect(topicsBody.topics[cloud.id].projectPath).toBe(projectDir);

    // ...and emitted pane:focus-suggest so the client opens + nests the session.
    await expect
      .poll(async () => (await frames(page)).some((f) => f.type === "pane:focus-suggest"), { timeout: 5000 })
      .toBe(true);
    const focus = (await frames(page)).find((f) => f.type === "pane:focus-suggest");
    expect(focus.topicId).toBe(cloud.id);
    expect(focus.projectPath).toBe(projectDir);

    await deleteTopic(request, cloud.id);
    await deleteTopic(request, anchor.id);
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("explicit '/project open <absolute path>' is trusted (trustRawPaths) and resolves", async ({
    request,
  }) => {
    const ts = Date.now().toString(36);
    const dir = `/tmp/e2e-cloud-abs-${ts}`;
    mkdirSync(dir, { recursive: true });
    const cloud = await createTopic(request, `CloudAbs-${ts}`);
    const sessionKey = `topic:${cloud.id.slice(0, 8)}`;

    // The /project command is an explicit local user action → a raw absolute
    // path is honoured even though the dir is not a pre-known project.
    const res = await request.post(`${BASE}/api/command`, {
      data: { command: "project", sessionKey, args: { sub: "open", value: dir } },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).path).toBe(dir);

    await deleteTopic(request, cloud.id);
    rmSync(dir, { recursive: true, force: true });
  });

  test("adopting a gateway session opens it as an interactive openclaw chat (idempotent)", async ({
    request,
  }) => {
    const ts = Date.now().toString(36);
    // A gateway-native session key that is NOT a Topics topic yet.
    const sessionKey = `agent:sub-${ts}`;

    const first = await request.post(`${BASE}/api/topics/adopt`, {
      data: { sessionKey, name: `Adopted ${ts}` },
      ignoreHTTPSErrors: true,
    });
    expect(first.ok()).toBeTruthy();
    const t1 = await first.json();
    expect(t1.sessionKey).toBe(sessionKey);   // bound to the EXISTING session
    expect(t1.provider).toBe("openclaw");     // cloud-backed → interactive

    // Idempotent: adopting again returns the same topic, not a duplicate.
    const second = await request.post(`${BASE}/api/topics/adopt`, {
      data: { sessionKey },
      ignoreHTTPSErrors: true,
    });
    expect(second.ok()).toBeTruthy();
    const t2 = await second.json();
    expect(t2.id).toBe(t1.id);

    await deleteTopic(request, t1.id);
  });
});
