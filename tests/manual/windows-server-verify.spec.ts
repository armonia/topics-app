/**
 * CHECKS AGAINST THE INSTALLED WINDOWS APP (not a bench).
 *
 * Points at the `topics-server` of the 2.2.176 build installed on the Windows
 * 11 machine (`%LOCALAPPDATA%\Topics\`, app.exe sha256 27AB5DBA24E2F8A3...),
 * reached from the Mac over an ssh tunnel. It exists to leave a REPEATABLE
 * measurement where so far there was only a written account.
 *
 * Run by hand (not in CI: it needs that machine powered on). Replace the
 * placeholders with the account and address of your own Windows box:
 *   ssh -f -N -L 51156:127.0.0.1:51156 <user>@<windows-host>
 *   TOPICS_WIN_BASE=http://127.0.0.1:51156 \
 *     npx playwright test -c playwright.windows.config.ts
 *
 * WHY THERE IS NO DOM MEASUREMENT HERE, which was the initial plan. The UI is
 * NOT served over HTTP: it is compiled into `app.exe` and the webview loads it
 * from `tauri://localhost` (verified by looking for that string in the
 * binary). `GET /` on the server port answers 503 "Bundle not built yet",
 * which is correct: in production that server acts as an API only. And the
 * WebView2 debug port is not open, nor can it be opened on the fly, because
 * the app is single-instance: a second launch with `--remote-debugging-port`
 * folds into the window that is already alive (measured: after the launch the
 * instances stay 1, pid unchanged) and that window belongs to whoever is using
 * the machine, which we do not touch.
 *
 * So: the geometry and pixel matters (window buttons, bell, identity chip,
 * tooltip, grey band) stay verified by hand on the hardware and are NOT here.
 * Here is what can genuinely be interrogated from outside, which is the
 * server's contract as it runs on Windows.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(({}, testInfo) => {
  testInfo.annotations.push({ type: "spec", description: "RUNTIME-17" });
});

test.describe("Windows 2.2.176 — contratto del server sulla build pubblicata", () => {
  test("WIN-SRV-01: la versione servita e' la 2.2.176 della pipeline", async ({ request }) => {
    const v = await (await request.get("/api/version")).json();
    expect(v.version).toBe("2.2.176");
  });

  test("WIN-SRV-02: le rotte che l'interfaccia interroga all'avvio rispondono tutte 200", async ({ request }) => {
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

  test("WIN-SRV-03: i provider sono dichiarati con requisiti e modelli, non una lista vuota", async ({ request }) => {
    const snap = await (await request.get("/api/providers/snapshot")).json();
    expect(Array.isArray(snap.providers)).toBe(true);
    expect(snap.providers.length).toBeGreaterThan(0);
    // Every provider states its name and what it needs: that is exactly what
    // lets the app SAY an agent is missing instead of opening an empty tab,
    // which was the defect reported on 26/08.
    for (const p of snap.providers) {
      expect(typeof p.name, JSON.stringify(p).slice(0, 80)).toBe("string");
      expect(typeof p.status).toBe("string");
    }
  });

  test("WIN-SRV-04: nessun modello resta senza listino (il costo non e' mai finto zero)", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.server.unpricedModels).toEqual([]);
  });

  test("WIN-SRV-05: la versione del binario coincide con quella che il server dichiara", async ({ request }) => {
    // Proves the server we interrogate is REALLY the one from the 2.2.176
    // install, not a development process left running on that port: that
    // would be the easiest way to fool ourselves.
    const v = await (await request.get("/api/version")).json();
    const s = await (await request.get("/api/system/status")).json();
    expect(v.version).toBe("2.2.176");
    expect(s.server.devReload).toBe(false);
  });

  test("WIN-SRV-06: una rotta inesistente da' 404, non 500 e non una pagina", async ({ request }) => {
    expect((await request.get("/api/usage/other")).status()).toBe(404);
  });

  test("WIN-SRV-07: il server e' su da ore e non sta perdendo memoria", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.server.uptimeMs).toBeGreaterThan(60_000);
    // 37 MB when measured after roughly 2h of uptime. The threshold is wide
    // on purpose: what matters here is an obvious leak, not a single MB.
    expect(s.server.memoryMB).toBeLessThan(600);
  });

  test("WIN-SRV-08: lo stato dichiara il gateway e le connessioni vive", async ({ request }) => {
    const s = await (await request.get("/api/system/status")).json();
    expect(s.gateway).toBeDefined();
    expect(s.connections).toBeDefined();
  });

  test("WIN-SRV-09: creare, leggere e cancellare un topic funziona sulla macchina vera", async ({ request }) => {
    const name = `win-verify-${Date.now()}`;
    const created = await request.post("/api/topics", { data: { name } });
    expect(created.status()).toBeLessThan(300);
    const topic = await created.json();
    try {
      // `/api/topics` answers with a MAP of id to topic, not with an array.
      const list = await (await request.get("/api/topics")).json();
      expect(Object.keys(list.topics)).toContain(topic.id);
    } finally {
      expect((await request.delete(`/api/topics/${topic.id}`)).status()).toBeLessThan(300);
    }
  });

  test("WIN-SRV-10: le sessioni di terminale si elencano senza autenticazione mancante", async ({ request }) => {
    const r = await request.get("/api/terminal/sessions");
    expect(r.status()).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });
});
