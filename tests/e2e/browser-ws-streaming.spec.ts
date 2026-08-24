import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

// W7: Wave-0 dep on Task 0. Resolve relative to spec file (works from any cwd).
const PERF_PATH = resolvePath(__dirname, "perf-baseline.json");
const PERF = JSON.parse(readFileSync(PERF_PATH, "utf-8")).browser_ws_streaming as {
  fps_floor: number;
  frame_count_in_2s_floor: number;
  input_latency_p95_ms_ceiling: number;
  input_latency_sample_size_min: number;
  bandwidth_kbps_ceiling: number;
  first_frame_ms_ceiling: number;
  fallback_http_grace_ms_ceiling: number;
};

/**
 * Mount a RemoteBrowserPanel for `topicId` by dispatching the canonical
 * `browser:open-and-navigate` CustomEvent (the same one ChatPane fires for
 * `/browser <url>` slash command). Resolves once the browser-connection
 * indicator becomes visible.
 *
 * Phase 30-04 retired the legacy "sezione Browser" sidebar control; tests
 * MUST mount the panel via this CustomEvent now.
 */
async function mountBrowserPane(
  page: import("@playwright/test").Page,
  topicId: string,
  url = "https://example.com",
): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", {
          detail: { topicId: tid, url: u },
        }),
      );
    },
    { tid: topicId, u: url },
  );
  // Gate on the toolbar URL input — always present once the panel mounts. The
  // connection-indicator pill is no longer a stable gate: it hides in the steady
  // 'connected' state (the "Live" chip is noise), so it's absent once streaming.
  await expect(page.locator('[data-browser-pane]').first()).toBeVisible({
    timeout: 10000,
  });
}

// Chi sporca pulisce: vedi la docstring di `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("BROWSER-CHAT-02 WebSocket streaming", () => {
  // Reset pane-store-v2 BEFORE each test so a browser pane left over from a
  // prior test in this serial suite doesn't survive into the next one. A
  // stale pane keeps ownership of the active surface — the new pane mounts
  // but never activates (isPaneActive=false → frames dropped, navigateUrl
  // prop withheld) — and its lingering [data-testid="browser-connection-
  // indicator"] trips Playwright strict-mode ("resolved to 2 elements").
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-02" });
    testInfo.annotations.push({ type: "plan", description: "@plan-30-05" });
    await resetPaneStore(request, []);
  });

  test("frame WS arrives push-driven within 500ms of first navigation [BROWSER-CHAT-02 / @plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });

    // Track first frame arrival via a script eval that hooks into the WS receive.
    let firstFrameAt = 0;
    let openAt = 0;
    await page.exposeFunction("__recordFirstFrame", (ts: number) => {
      if (!firstFrameAt) firstFrameAt = ts;
    });
    await page.exposeFunction("__recordWsOpen", (ts: number) => {
      if (!openAt) openAt = ts;
    });
    await page.addInitScript(() => {
      const origWs = window.WebSocket;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).WebSocket = class extends origWs {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes("/ws/browser/")) {
            this.addEventListener("open", () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).__recordWsOpen(Date.now());
            });
            this.addEventListener("message", (e) => {
              try {
                const m = JSON.parse((e as MessageEvent).data);
                if (m.type === "frame") {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (window as any).__recordFirstFrame(Date.now());
                }
              } catch { /* ignore */ }
            });
          }
        }
      };
    });

    const topic = await createTopic(request, `E2E-WSFirstFrame-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // Poll for first frame arrival.
      await expect.poll(() => firstFrameAt, { timeout: 5000 }).toBeGreaterThan(0);
      // Compare against WS open timestamp (not page goto) — the contract is
      // "first frame within N ms of WS open" per spec.md.
      const elapsed = openAt > 0 ? firstFrameAt - openAt : firstFrameAt - Date.now() + 5000; // safety
      console.log(
        `[ws-streaming] first frame at +${elapsed}ms after WS open (ceiling ${PERF.first_frame_ms_ceiling}ms)`,
      );
      expect(elapsed).toBeLessThan(PERF.first_frame_ms_ceiling);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("input latency p95 < 150ms (20 click samples) [BROWSER-CHAT-02 / @plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 30 }); // tighter window
    await browserProcessPageV2.mockWebrtcPeer(); // clickable surface = WebRTC <video>
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });

    const samples: number[] = [];
    await page.exposeFunction("__recordSample", (dt: number) => {
      samples.push(dt);
    });
    await page.addInitScript(() => {
      const orig = window.WebSocket;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).WebSocket = class extends orig {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!String(url).includes("/ws/browser/")) return;
          let lastInputAt = 0;
          const origSend = this.send.bind(this);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).send = (data: any) => {
            try {
              const m = JSON.parse(String(data));
              if (m.type === "input" && m.action === "click") {
                lastInputAt = Date.now();
              }
            } catch { /* ignore */ }
            origSend(data);
          };
          this.addEventListener("message", (e) => {
            try {
              const m = JSON.parse((e as MessageEvent).data);
              if (m.type === "frame" && lastInputAt) {
                const dt = Date.now() - lastInputAt;
                lastInputAt = 0;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).__recordSample(dt);
              }
            } catch { /* ignore */ }
          });
        }
      };
    });

    const topic = await createTopic(request, `E2E-WSLatency-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // The clickable surface is now the WebRTC <video>. A synthetic stream has
      // videoWidth=0, so mapCoordinates falls back to the 1280×720 viewport basis
      // (browserCoords.intrinsicSize) — clicks map cleanly with no DOM patch. The
      // input→frame round trip still rides the mocked WS (the mock keeps pushing
      // frames), so the p95 latency contract is unchanged, just measured on <video>.
      const screenshotImg = page.locator('[data-testid="browser-webrtc-video"]');
      await screenshotImg.first().waitFor({ state: "visible", timeout: 10000 });

      // W6 FIX: rAF-based sample spacing (NOT waitForTimeout). Double rAF
      // guarantees a frame interval between clicks, event-driven.
      // Convention exception: this is sample-spacing for stable p95.
      const box = await screenshotImg.first().boundingBox();
      const cx = (box?.width ?? 200) / 2;
      const cy = (box?.height ?? 200) / 2;
      // Si clicca FINCHÉ i campioni bastano, non un numero fisso di volte.
      //
      // Un click e un frame non sono accoppiati: se il click successivo parte
      // prima che arrivi un frame, sovrascrive `lastInputAt` e il campione
      // precedente non nasce. Quante coppie si perdono dipende da come i click
      // cadono rispetto ai frame mockati a 30fps — cioè dal caso. Con un margine
      // fisso (`min + 6`) bastava perderne sette per un rosso: `Expected: >= 20,
      // Received: 19` con una p95 sanissima (55ms su un tetto di 150). Il numero
      // di click non è il contratto; il contratto è "almeno N campioni, e la
      // loro p95 sta sotto il tetto". Il tetto sotto NON si tocca: si campiona
      // finché ce n'è abbastanza per misurarlo.
      const wantedSamples = PERF.input_latency_sample_size_min;
      const maxClicks = wantedSamples * 5; // ~80% di perdita e regge ancora
      const clickDeadline = Date.now() + 15_000; // < timeout del test (30s)
      let clicks = 0;
      while (samples.length < wantedSamples && clicks < maxClicks && Date.now() < clickDeadline) {
        // Click around center; small jitter keeps each click distinct.
        await screenshotImg.first().click({
          position: { x: cx + (clicks % 5) - 2, y: cy + (clicks % 7) - 3 },
          force: true,
        });
        clicks++;
        await page.evaluate(
          () =>
            new Promise<void>((r) =>
              requestAnimationFrame(() => requestAnimationFrame(() => r())),
            ),
        );
      }

      // Drain samples; compute p95. L'ultimo click può avere un frame ancora in
      // volo: la poll gli dà il tempo di atterrare.
      await expect
        .poll(() => samples.length, { timeout: 8000 })
        .toBeGreaterThanOrEqual(wantedSamples);
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * (sorted.length - 1))];
      console.log(
        `[ws-streaming] latency samples=${samples.length}, p95=${p95}ms (target < ${PERF.input_latency_p95_ms_ceiling}ms)`,
      );
      expect(p95).toBeLessThan(PERF.input_latency_p95_ms_ceiling);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("FPS >= 15 sustained over 2s window with 30+ frames [BROWSER-CHAT-02 / @plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });

    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__recordedFrameCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__recordedTotalBytes = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__startedAt = 0;
      const orig = window.WebSocket;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).WebSocket = class extends orig {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (!String(url).includes("/ws/browser/")) return;
          this.addEventListener("message", (e) => {
            try {
              const data = (e as MessageEvent).data;
              const m = JSON.parse(data);
              if (m.type === "frame") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (!(window as any).__startedAt) (window as any).__startedAt = Date.now();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).__recordedFrameCount++;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).__recordedTotalBytes += String(data).length;
              }
            } catch { /* ignore */ }
          });
        }
      };
    });

    const topic = await createTopic(request, `E2E-WSFps-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // W6 FIX: drive by frame count, not absolute time.
      await page.waitForFunction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (floor) => (window as any).__recordedFrameCount >= floor,
        PERF.frame_count_in_2s_floor,
        { timeout: 4000 }, // 2s budget + 2s margin for slowMo + CI jitter
      );

      const counters = await page.evaluate(() => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        count: (window as any).__recordedFrameCount as number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bytes: (window as any).__recordedTotalBytes as number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        startedAt: (window as any).__startedAt as number,
      }));
      const elapsed = Date.now() - counters.startedAt;
      const bandwidthKbps = ((counters.bytes * 8) / 1000) / (elapsed / 1000);
      console.log(
        `[ws-streaming] frames=${counters.count} in ${elapsed}ms (target >= ${PERF.frame_count_in_2s_floor}); bandwidth=${Math.round(bandwidthKbps)} kbps (ceiling ${PERF.bandwidth_kbps_ceiling})`,
      );
      expect(counters.count).toBeGreaterThanOrEqual(PERF.frame_count_in_2s_floor);
      expect(bandwidthKbps).toBeLessThan(PERF.bandwidth_kbps_ceiling);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("auto-reconnect: a transient WS drop re-opens the socket, the shared session recovers [native-grade]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // shared-session <video> surface
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-WSReconnect-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // The live <video> proves the WS + WebRTC transport is up (connected).
      const video = page.locator('[data-testid="browser-webrtc-video"]');
      await expect(video).toBeVisible({ timeout: 10000 });
      const connectsBefore = browserProcessPageV2.getWsConnectCount();

      // Transient drop: the WebRTC signaling rode this WS, so the pane tears the
      // <video> down — but the client must auto-reconnect (open a NEW socket)
      // rather than be stranded in polling. Observed via the mock's connection
      // count so we don't race the connection-indicator class transitions.
      browserProcessPageV2.closeWs();
      await expect
        .poll(() => browserProcessPageV2.getWsConnectCount(), { timeout: 8000 })
        .toBeGreaterThan(connectsBefore);
      // Recovery: the reconnect renegotiates the transport → the <video> returns
      // (no permanent degradation to polling / a dead pane after the blip).
      await expect(video).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("WS unavailable → connection state degrades to fallback-http, never stuck 'connecting' [BROWSER-CHAT-02 / @plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    // Make the browser WS constructor throw so no socket can open — the client
    // then can't reconnect and degrades to the fallback-http FLOOR.
    await page.addInitScript(() => {
      const orig = window.WebSocket;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).WebSocket = class extends orig {
        constructor(url: string | URL, protocols?: string | string[]) {
          if (String(url).includes("/ws/browser/")) throw new Error("WS blocked (test)");
          super(url, protocols);
        }
      };
    });

    const topic = await createTopic(request, `E2E-WSFallback-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      const indicator = page.locator('[data-testid="browser-connection-indicator"]');
      await expect(indicator).toBeVisible({ timeout: 10000 });
      // No WS → the state machine must move to fallback-http (the "Polling"
      // pill), never hang in 'connecting'. The visible surface is now the WebRTC
      // <video>, which needs the WS to signal — with no WS there's no JPEG
      // fallback render anymore (design: "zero JPEG shown"), so we assert on the
      // connection STATE the machine reports, not a screenshot.
      await expect(indicator).toHaveClass(/connection-fallback/, {
        timeout: PERF.fallback_http_grace_ms_ceiling,
      });
      await expect(indicator).not.toHaveClass(/connection-connecting/);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("resize: pane streams its real size (+DPR) on open AND on size change [native-grade]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-WSResize-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // Accumulate inbound messages (drainInputMessages clears each call).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seen: any[] = [];
      const pollResizes = () => {
        seen.push(...browserProcessPageV2.drainInputMessages());
        return seen.filter((m) => m?.type === "resize");
      };

      // 1. A resize is sent right on WS open — kills the fixed-1280 letterbox.
      await expect.poll(pollResizes, { timeout: 6000 }).not.toHaveLength(0);
      const first = seen.find((m) => m?.type === "resize");
      expect(first.width).toBeGreaterThan(0);
      expect(first.height).toBeGreaterThan(0);
      expect(first.deviceScaleFactor).toBeGreaterThanOrEqual(1);

      // 2. Changing the window size drives the ResizeObserver → a new resize.
      const before = pollResizes().length;
      await page.setViewportSize({ width: 700, height: 620 });
      await expect.poll(() => pollResizes().length, { timeout: 6000 }).toBeGreaterThan(before);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("menu Download: la voce compare nella toolbar, si apre da sé, si toglie e si svuota [native-grade]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // shared-session <video> surface
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-WSDownload-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);
      // The live <video> proves the WS is streaming (connected), so a
      // sendDownload will reach the client. Avoids racing the indicator class.
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 10000 });

      browserProcessPageV2.sendDownload({
        filename: "report.pdf",
        href: "/media/browser/downloads/report.pdf",
        size: 4096,
        state: "completed",
      });

      // 1. Il download si annuncia da solo: bottone nella toolbar + menu aperto
      //    (la vecchia striscia in fondo alla pane non c'è più).
      const button = page.locator('[data-testid="browser-downloads-button"]');
      await expect(button).toBeVisible({ timeout: 5000 });
      await expect(page.locator('[data-testid="browser-download-strip"]')).toHaveCount(0);
      const menu = page.locator('[data-testid="browser-downloads-menu"]');
      await expect(menu).toBeVisible({ timeout: 5000 });
      const link = menu.locator('[data-testid="browser-download-item"]');
      await expect(link).toContainText("report.pdf");
      await expect(link).toHaveAttribute("href", "/media/browser/downloads/report.pdf");
      await expect(menu.locator('[data-testid="browser-download-entry"]')).toHaveText(/4 KB/);

      // 2. È CHIUDIBILE — il reclamo originale. Esc lo chiude, il bottone lo riapre.
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await button.click();
      await expect(menu).toBeVisible();

      // 3. La voce si toglie a mano, e con l'ultima sparisce anche il bottone
      //    (a riposo la toolbar torna com'era).
      await menu.locator('[data-testid="browser-download-dismiss"]').first().click();
      await expect(button).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
