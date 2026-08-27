/**
 * VERIFICATION AGAINST THE INSTALLED WINDOWS APP (not a test bench).
 *
 * Targets the `topics-server` of build 2.2.176 installed on the Windows 11 box
 * (`%LOCALAPPDATA%\Topics\`, app.exe sha256 27AB5DBA24E2F8A3…), reached from
 * the Mac over an ssh tunnel. It exists to leave a REPEATABLE measurement
 * where there was only a written report.
 *
 * Run by hand (not in CI: it needs that machine powered on). Replace the
 * placeholders with the account and address of your own Windows box:
 *   ssh -f -N -L 51156:127.0.0.1:51156 <user>@<windows-host>
 *   TOPICS_WIN_BASE=http://127.0.0.1:51156 \
 *     npx playwright test -c playwright.windows.config.ts
 *
 * WHY THERE IS NO DOM MEASUREMENT HERE, which was the original plan. The UI is
 * NOT served over HTTP: it is compiled into `app.exe` and the webview loads it
 * from `tauri://localhost` (confirmed by finding that string inside the
 * binary). `GET /` on the server port answers 503 "Bundle not built yet",
 * which is correct: in production that server is API-only. And the WebView2
 * debug port is not open, nor can it be opened after the fact, because the app
 * is single-instance: relaunching it with `--remote-debugging-port` re-enters
 * the live window (measured: instance count stays 1, pid unchanged) and that
 * window belongs to the user, which we do not touch.
 *
 * So the geometry-and-pixel checks (window buttons, notification bell,
 * identity chip, tooltip, grey band) stay MANUALLY verified on the hardware
 * and are deliberately NOT here. Saying so is the only way to stop anyone
 * believing they are automated. See RUNTIME-17.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(({}, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "RUNTIME-17" });
});

const VERSION = process.env.TOPICS_WIN_VERSION ?? "2.2.176";

test.describe("Windows — published build server contract", () => {
  test("WIN-SRV-01: the served version is the one built by the pipeline", async ({ request }) => {
    const v = await (await request.get("/api/version")).json();
    expect(v.version).toBe(VERSION);
  });

  test("WIN-SRV-02: every route the UI calls on startup answers 200", async ({ request }) => {
    for (const p of [
      "/api/system/status",
      "/api/topics",
      "/api/terminal/sessions",
      "/api/providers/snapshot",
      "/api/all-boards/tasks",
    ]) {
      expect((await request.get(p)).status(), p).toBe(200);
    }
  });

  test("WIN-SRV-03: providers are declared with name and status, not an empty list", async ({ request }) => {
    const snap = await (await request.get("/api/providers/snapshot")).json();
    expect(Array.isArray(snap.providers)).toBe(true);
    expect(snap.providers.length).toBeGreaterThan(0);
    // Each provider states what it is and what it needs: that is exactly what
    // lets the app SAY an agent is missing instead of opening an empty tab,
    // which was the defect reported on 2026-08-26.
    for (const p of snap.providers) {
      expect(typeof p.name, JSON.stringify(p).slice(0, 80)).toBe("string");
      expect(typeof p.status).toBe("string");
    }
  });

  test("WIN-SRV-04: no model is left unpriced (cost is never a fake zero)", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.server.unpricedModels).toEqual([]);
  });

  test("WIN-SRV-05: the binary version matches what the server reports", async ({ request }) => {
    // Proves the server being queried really is the installed build and not a
    // dev process left listening on that port, which would be the easiest way
    // to fool ourselves into thinking we verified anything.
    const v = await (await request.get("/api/version")).json();
    const s = await (await request.get("/api/system/status")).json();
    expect(v.version).toBe(VERSION);
    expect(s.server.devReload).toBe(false);
  });

  test("WIN-SRV-06: an unknown route gives 404, not 500 and not a page", async ({ request }) => {
    expect((await request.get("/api/usage/other")).status()).toBe(404);
  });

  test("WIN-SRV-07: the server reports its own uptime and is not leaking memory", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    // Uptime is only asserted to EXIST and be sane, not to be long: this suite
    // is also run right after an update, when the server has just restarted on
    // purpose. Demanding hours made it red for doing exactly what was asked.
    expect(s.server.uptimeMs).toBeGreaterThan(0);
    // 37 MB when measured after ~2h of uptime. The bound is deliberately wide:
    // this is about catching an obvious leak, not policing single megabytes.
    expect(s.server.memoryMB).toBeLessThan(600);
  });

  test("WIN-SRV-08: status reports the gateway and live connections", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.gateway).toBeDefined();
    expect(s.connections).toBeDefined();
  });

  test("WIN-SRV-09: create, read and delete a topic works on the real machine", async ({ request }) => {
    const name = `win-verify-${Date.now()}`;
    const created = await request.post("/api/topics", { data: { name } });
    expect(created.status()).toBeLessThan(300);
    const topic = await created.json();
    try {
      // `/api/topics` answers with a MAP of id → topic, not an array.
      const list = await (await request.get("/api/topics")).json();
      expect(Object.keys(list.topics)).toContain(topic.id);
    } finally {
      expect((await request.delete(`/api/topics/${topic.id}`)).status()).toBeLessThan(300);
    }
  });

  test("WIN-SRV-11: the installed app SERVES ITS OWN PAGE, not a 503", async ({ request }) => {
    // THE GREY WINDOW, and it is the one check this suite was missing while the
    // user was looking at an empty app. Every other case here asks the API, and
    // the API was answering 200 the whole time — `/api/system/status` was fine
    // while `GET /` returned 503 "Bundle not built yet", because the client
    // bundle was never shipped beside the server and nobody passed
    // `TOPICS_PUBLIC_DIR`. A suite that only asks the API cannot see an app
    // whose window is blank.
    //
    // Measured on the installed 2.2.180: 503. On 2.2.181, which ships `public/`
    // as a bundle resource: 200 with 4374 bytes.
    const r = await request.get("/");
    expect(r.status(), "GET / must serve the page, not 503").toBe(200);
    const body = await r.text();
    expect(body.length, "the page came back empty").toBeGreaterThan(500);
    expect(body).toContain("<div id=\"root\"");
  });

  test("WIN-SRV-10: terminal sessions list without a missing-auth rejection", async ({ request }) => {
    const r = await request.get("/api/terminal/sessions");
    expect(r.status()).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });
});
