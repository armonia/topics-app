import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file restarts from the globalSetup baseline, not from
// whatever the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

// Whoever makes the mess cleans it: see the docstring of `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

/**
 * In a shared session the viewport belongs to whoever USES the page, and
 * everyone else sees it scaled and centred.
 *
 * One server-side browser context can have several viewers: the Mac pane, a
 * phone on the same network, a task drawer. Each one streams its own size from
 * a ResizeObserver, and the server used to apply the last `resize` that
 * arrived, so a phone that merely OPENED the shared context reflowed the page
 * to 390 px under the hands of whoever was typing on the Mac. Nothing errored:
 * the page simply became a phone page.
 *
 * The two halves of the rule are proved with the tool each one needs:
 *
 *   1. the arbitration, against the REAL server: two Playwright contexts with
 *      different sizes on the same contextId, and the size the headless page
 *      actually has, read back from `/api/browsers/:id/agent/eval`. No mock:
 *      the arbiter lives in the server's socket branch, and a stub would prove
 *      the stub.
 *   2. the centring, on the mock harness, where it is deterministic: the
 *      geometry is a function of the container/page pair and needs no real
 *      Chromium to be wrong.
 *
 * @covers TOPIC-BROWSER-05
 */

/** The rrweb burst captured offline, reused here with a wider Meta. */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as { type: number; data?: Record<string, unknown> }[];

/** The sample's Meta says 900x600; this needs a desk-sized page instead. */
const RECORDED_WIDTH = 1280;
const RECORDED_HEIGHT = 800;

function eventsWithRecordedViewport(width: number, height: number): unknown[] {
  return RRWEB_EVENTS.map((event) =>
    event.type === 4
      ? { ...event, data: { ...(event.data ?? {}), width, height } }
      : event,
  );
}

test.describe("Arbitro del viewport in sessione condivisa", () => {
  /**
   * THIS FILE IS OUT OF THE PR GATE, for its family's reason.
   *
   * The first test makes the server launch a headless Chromium (the `resize` is
   * the very thing that creates the context). Under the gate's four shards that
   * launch times out at 180s - measured on the same family, see the comment on
   * `browser-shared-session` - and the red would accuse the arbiter, which has
   * nothing to do with it: there was no page whose viewport could be measured.
   * So it sits in `NIGHTLY_ONLY_SPECS`, where it runs unsharded.
   */
  test("l'arbitro del viewport: chi guarda non rimpicciolisce chi usa", async ({ browser, request }) => {
    // The file cap is 30s and it is not enough here: this waits for the server
    // to launch a headless Chromium, then three round trips against the page.
    test.setTimeout(180_000);

    const contextId = `e2e-arbiter-${Date.now()}`;
    const evaluateUrl = `${E2E_BASE}/api/browsers/${encodeURIComponent(contextId)}/agent/eval`;

    /** The size the headless page REALLY has, not the one it was asked for. */
    const readViewport = async (): Promise<string> => {
      const res = await request.post(evaluateUrl, {
        data: { expression: "[window.innerWidth, window.innerHeight].join('x')" },
        timeout: 60_000,
      });
      if (!res.ok()) return `http ${res.status()}`;
      const body = (await res.json()) as { result?: unknown; error?: string };
      if (body.error) return body.error;
      return typeof body.result === "string" ? body.result : JSON.stringify(body.result);
    };

    // Two real devices with two different sizes: the desk and the phone.
    const wide = await browser.newContext({ baseURL: E2E_BASE, viewport: { width: 1280, height: 800 } });
    const phone = await browser.newContext({ baseURL: E2E_BASE, viewport: { width: 390, height: 700 } });
    try {
      const widePage = await wide.newPage();
      const phonePage = await phone.newPage();
      await goToApp(widePage);
      await goToApp(phonePage);

      /**
       * Open a spectator socket on the shared context FROM INSIDE the page, so
       * the origin is the server's and the client is one of its own.
       *
       * It names itself with `?client=` exactly as a real pane does
       * (`client/src/lib/browserClientId.ts`): on this machine every browser is
       * the owner, so without that name the two contexts would be ONE claimant
       * and there would be nothing to arbitrate. Each Playwright context has
       * its own sessionStorage, so the two names differ by construction, the
       * way two devices differ.
       *
       * It also counts the `focus_field` frames received: that is this socket's
       * read receipt. WebSocket messages are ordered, so a `focus_query` sent
       * AFTER a `resize` only comes back once that `resize` has been handled -
       * which is how one waits for a NON-change without inventing a delay.
       */
      const attach = (page: import("@playwright/test").Page) =>
        page.evaluate(async (ctx) => {
          const wsBase = location.origin.replace(/^http/, "ws");
          const KEY = "topics-browser-client-id";
          let name = sessionStorage.getItem(KEY);
          if (!name) { name = crypto.randomUUID(); sessionStorage.setItem(KEY, name); }
          const socket = new WebSocket(
            `${wsBase}/ws/browser/${encodeURIComponent(ctx)}?client=${encodeURIComponent(name)}`,
          );
          const shared = window as unknown as { __arbiter?: { socket: WebSocket; acks: number } };
          const state = { socket, acks: 0 };
          socket.addEventListener("message", (ev) => {
            try {
              if (JSON.parse((ev as MessageEvent).data as string)?.type === "focus_field") state.acks += 1;
            } catch { /* non-JSON frame: not our receipt */ }
          });
          shared.__arbiter = state;
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve());
            socket.addEventListener("error", () => reject(new Error("ws error")));
          });
        }, contextId);

      const send = (page: import("@playwright/test").Page, message: unknown) =>
        page.evaluate((msg) => {
          const shared = window as unknown as { __arbiter: { socket: WebSocket } };
          shared.__arbiter.socket.send(JSON.stringify(msg));
        }, message);

      /** How many receipts this page has seen so far. */
      const acks = (page: import("@playwright/test").Page) =>
        page.evaluate(() => (window as unknown as { __arbiter: { acks: number } }).__arbiter.acks);

      /** Send the receipt question and wait for the answer to come back. */
      const roundTrip = async (page: import("@playwright/test").Page) => {
        const before = await acks(page);
        await send(page, { type: "focus_query" });
        await expect
          .poll(() => acks(page), { timeout: 60_000, message: "la socket non ha ricevuto la ricevuta del server" })
          .toBeGreaterThan(before);
      };

      // 1) The desk arrives first and asks for its own size. Nobody has touched
      //    the page yet, so the first client connected drives: this one.
      await attach(widePage);
      await send(widePage, { type: "resize", width: 1280, height: 800 });
      await expect
        .poll(readViewport, { timeout: 120_000, message: "il primo connesso deve poter imporre la sua misura" })
        .toBe("1280x800");

      // 2) The phone connects and streams its own size WITHOUT touching the
      //    page. It is a spectator: its `resize` must be dropped.
      await attach(phonePage);
      await send(phonePage, { type: "resize", width: 390, height: 700 });
      await roundTrip(phonePage);
      expect(await readViewport(), "un telefono che GUARDA non deve rimpicciolire la pagina di chi la usa").toBe("1280x800");

      // 3) Now the phone USES the page: a scroll, and the size that travels
      //    with the input (`driving`) is the size of whoever drives.
      await send(phonePage, { type: "input", action: "scroll", payload: { x: 10, y: 10, deltaX: 0, deltaY: 120 } });
      await send(phonePage, { type: "resize", width: 390, height: 700, driving: true });
      await expect
        .poll(readViewport, { timeout: 120_000, message: "chi tocca la pagina ne prende il viewport" })
        .toBe("390x700");
    } finally {
      await wide.close().catch(() => { /* best-effort */ });
      await phone.close().catch(() => { /* best-effort */ });
    }
  });
});
