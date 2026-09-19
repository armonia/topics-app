/**
 * server/browser-cdp-surface.ts — every raw CDP call the browser service makes,
 * in one file, each with the verdict on whether it survives a non-Chromium engine.
 *
 * WHY THIS FILE EXISTS. Card bf04951a (move the remote browser to Playwright
 * WebKit) names the raw-CDP parts as the thing to look at before committing:
 * "if a piece depends on naked CDP, THAT is the real work, not the switch".
 * Today those calls are scattered across ~1100 lines of browser-service.ts, so
 * the size of the migration can only be estimated by grepping. Gathering them
 * here changes nothing at runtime; it makes the day-of-migration diff a file
 * instead of a manhunt. The extraction is deliberately NOT a rewrite: same
 * calls, same order, same errors, same best-effort semantics.
 *
 * THE INVARIANT THAT MAKES IT WORTH IT: no `.send("…")` and no
 * `newCDPSession(` outside this module, under `server/` (the chromium-sidecar
 * engine path still calls `chromium.connectOverCDP`, which is an explicitly
 * Chromium-only feature by product decision, not an accident). Check:
 *
 *   /usr/bin/grep -rn 'newCDPSession(\|\.send("' server/*.ts \
 *     | /usr/bin/grep -v 'browser-cdp-surface.ts\|\.test\.ts'
 *
 * MEASURED, not assumed (spike/browser-engine-alt/, 19/09/2026):
 *   - WebKit refuses CDP outright: `newCDPSession` throws "CDP session is only
 *     available in Chromium". There is no alternative transport to find.
 *   - Repeated screenshots, the only route left on WebKit, run 67.1 FPS on a
 *     live page and 31.9 FPS on a dense scrolling page, against the 15 FPS floor
 *     of BROWSER-CHAT-02 (webkit-screencast.mjs).
 *   - `page.evaluate` survives `script-src 'self'` on BOTH engines and a
 *     top-level `var` in the evaluated source really does become a page global
 *     that a LATER separate evaluate can read; `addScriptTag` is refused on both
 *     (evaluate-vs-runtime.mjs). That is what makes the recorder injection
 *     portable — see the verdict on Runtime.evaluate below.
 *
 * THE SIX CALLS, AND WHAT EACH WOULD COST TO PORT.
 *
 *  1. Page.startScreencast      NOT PORTABLE — rewrite as a screenshot loop.
 *  2. Page.stopScreencast       Chromium pushes frames and throttles them with
 *  3. Page.screencastFrameAck   the ACK; on WebKit the server must pull
 *                               (page.screenshot in a paced loop) and the ACK
 *                               becomes "don't start the next grab until the
 *                               last one is written". The budget is verified,
 *                               the shape of the code is not the same code.
 *                               Watch KB/frame, not FPS: 200 KB/frame on a dense
 *                               page is 6 MB/s at 30 FPS toward a phone.
 *
 *  4. Runtime.evaluate          PORTABLE — `page.evaluate(source)` is equivalent
 *                               for this use, measured above on both engines:
 *                               CSP does not stop it (which is the whole reason
 *                               the code avoids addScriptTag) and the bundle's
 *                               top-level `var rrweb` still lands as a real page
 *                               global for the follow-up call. The one thing
 *                               that changes is error reporting: CDP hands back
 *                               `exceptionDetails` while evaluate throws, so the
 *                               unwrapping below collapses to a try/catch. Not
 *                               switched today: this is an extraction, and
 *                               swapping the injection path of the DOM co-browse
 *                               recorder deserves its own change with the rrweb
 *                               tests in front of it.
 *
 *  5. Storage.clearDataForOrigin  PORTABLE ONLY AT A PRICE. Playwright has no
 *                               API to clear localStorage/IndexedDB for an
 *                               origin the page is not on: `context.clearCookies`
 *                               covers cookies alone (browser-service.ts already
 *                               uses it for exactly that, in the same function).
 *                               The portable route is a throwaway page navigated
 *                               to each origin running a clear script, which is
 *                               precisely what the CDP call was chosen to avoid
 *                               ("l'origin da svuotare quasi mai è quello della
 *                               pagina aperta"). Cost: one navigation per origin
 *                               on "forget this site", and origins that no longer
 *                               resolve cannot be cleared at all. Equivalent in
 *                               outcome, not in cost or in reliability.
 *
 *  6. Target.getTargetInfo      NOT PORTABLE, AND DOES NOT NEED TO BE. Its only
 *                               consumer is getTargetId → webrtc-bridge, which
 *                               hands the targetId to a CDP-attaching H.264
 *                               sidecar (server.ts, webrtc_offer). A CDP target
 *                               id is meaningless without CDP: on WebKit the
 *                               whole WebRTC upgrade path is absent and the
 *                               client keeps its JPEG stream, which the code
 *                               already treats as the no-regression fallback.
 *                               So this one gets skipped on a non-Chromium
 *                               engine, not translated.
 *
 * Both non-portable groups therefore turn into "engine has no CDP" branches, not
 * into ports. Only Runtime.evaluate is a straight swap, and only
 * clearDataForOrigin is a genuine trade-off to decide when the time comes.
 */
import type { BrowserContext, CDPSession, Page } from "playwright-core";

/** Options a screencast can be started with. Mirrors the subset of
 *  Page.startScreencast params the service actually sets. */
export interface ScreencastOpts {
  format?: 'jpeg' | 'png';
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

/** The Page.screencastFrame payload, narrowed to the fields we read. */
export interface ScreencastFramePayload {
  data: string;
  sessionId: number;
  metadata: {
    timestamp?: number;
    pageScaleFactor?: number;
    deviceWidth?: number;
    deviceHeight?: number;
  };
}

/** Open a raw CDP session on a page. Chromium-only by construction: on WebKit
 *  and Firefox this is the call that throws "CDP session is only available in
 *  Chromium", so it is the single choke point an engine check would guard. */
export function openCdpSession(context: BrowserContext, page: Page): Promise<CDPSession> {
  return context.newCDPSession(page);
}

/**
 * Read the CDP targetId of a page, on a session opened and detached for just
 * this question (it must not linger attached for the context lifetime).
 * Returns null when the browser answers without one. Throws on a CDP failure —
 * callers decide how loud that is, and today both of them only warn.
 *
 * Portability: see (6) above. No equivalent outside Chromium, and no need for one.
 */
export async function captureTargetId(context: BrowserContext, page: Page): Promise<string | null> {
  const session = await openCdpSession(context, page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
    return info?.targetInfo?.targetId ?? null;
  } finally {
    // Detach failure is non-fatal (the context may already be closing).
    await session.detach().catch(() => {});
  }
}

/**
 * Wipe localStorage + IndexedDB for origins the open page is NOT on, which is
 * the normal case when forgetting a site. Opens and detaches its own session.
 * Throws on the first failure; the caller logs and moves on, because the
 * storage file is rewritten afterwards anyway.
 *
 * Portability: see (5) above — the replacement costs a navigation per origin.
 */
export async function clearOriginStorage(
  context: BrowserContext,
  page: Page,
  origins: string[],
): Promise<void> {
  let session: CDPSession | null = null;
  try {
    session = await openCdpSession(context, page);
    for (const origin of origins) {
      await session.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "local_storage,indexeddb",
      });
    }
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

/**
 * Run source at page-global scope AS THE DEBUGGER, which is CSP-exempt. Used to
 * inject the rrweb recorder bundle: a real inline <script> (addScriptTag) is
 * refused by `script-src 'self'` on most of the modern web, measured on both
 * engines, so the bundle would silently never run and DOM co-browse would fall
 * back to video everywhere.
 *
 * Throws with the page-side description when the expression raised — CDP
 * reports that in the RESULT, not as a transport error, so an unchecked call
 * here looks successful while nothing ran.
 *
 * Portability: see (4) above — `page.evaluate(source)` is a measured equivalent,
 * including the CSP exemption and the top-level-var-becomes-a-global part.
 */
export async function evaluateInPageGlobalScope(cdp: CDPSession, expression: string): Promise<void> {
  const res = (await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: false,
    awaitPromise: false,
  })) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "rrweb eval error");
  }
}

/** Subscribe to pushed screencast frames. The handler must ACK (see
 *  ackScreencastFrame) before doing anything slow, or the stream stalls. */
export function onScreencastFrame(cdp: CDPSession, handler: (payload: ScreencastFramePayload) => void): void {
  cdp.on("Page.screencastFrame" as never, handler as never);
}

/**
 * Acknowledge a frame. This is CDP's built-in flow control: the browser holds
 * the NEXT frame until the current one is ACKed, which is why the service ACKs
 * before fanning the frame out to viewers rather than after.
 *
 * Portability: on a pull-based engine there is nothing to acknowledge — the
 * equivalent is simply not starting the next screenshot until this one is out.
 */
export function ackScreencastFrame(cdp: CDPSession, sessionId: number): Promise<unknown> {
  return cdp.send("Page.screencastFrameAck", { sessionId });
}

/**
 * Frame params from the pane geometry, in ONE place because two callers need
 * them identical: the first start, and the restart after a resize. Chromium
 * locks maxWidth/maxHeight at start time, so an enlarged pane that is not
 * restarted keeps streaming upscaled old-size frames.
 *
 * width/height are CSS px; dsf is the context's creation-time HiDPI factor
 * (immutable in Playwright), so frames carry the retina detail instead of
 * having it downscaled away — clamping to the CSS width would throw it away.
 * `deviceWidth` in the frame metadata stays CSS px (DIP) either way, so click
 * mapping on the client is unaffected by the multiplier. Explicit caller values
 * always win — they are a deliberate clamp.
 */
export function screencastParams(
  opts: ScreencastOpts | undefined,
  width: number,
  height: number,
  dsf: number,
): Required<Pick<ScreencastOpts, 'format' | 'quality' | 'maxWidth' | 'maxHeight' | 'everyNthFrame'>> {
  return {
    format: opts?.format ?? "jpeg",
    // At >1x a frame carries ~4x the pixels — trim quality to hold the band.
    quality: opts?.quality ?? (dsf > 1 ? 60 : 70),
    maxWidth: opts?.maxWidth ?? Math.round(width * dsf),
    maxHeight: opts?.maxHeight ?? Math.round(height * dsf),
    everyNthFrame: opts?.everyNthFrame ?? 2,
  };
}

/** Start pushing frames. Defaults come from screencastParams (BROWSER-CHAT-02
 *  budget: jpeg q70, everyNthFrame=2 → a 15 FPS floor).
 *  Doc: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast */
export function startScreencast(cdp: CDPSession, params: ReturnType<typeof screencastParams>): Promise<unknown> {
  return cdp.send("Page.startScreencast", params);
}

/** Stop pushing frames. Leaves the session attached — the caller detaches. */
export function stopScreencast(cdp: CDPSession): Promise<unknown> {
  return cdp.send("Page.stopScreencast");
}
