/**
 * THE OPENING SEQUENCE OF `open_browser_pane`, IN ONE PLACE.
 *
 * It lives in its own module because three routes (chat, board task, terminal)
 * call it and browser-bridge.ts, which hosts all three, had grown to the line
 * where the size gate stops it. The doc of the sequence, the fallback that
 * mounts a pane nobody took, and the verdict on where the view actually landed
 * are one subject: they now sit together instead of being buried in the router.
 */
import type { BrowserService } from "../browser-service";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { dispatchBrowserToolCallByContext } from "../browser-tool-dispatcher";
import { blankPaneFailure, settledUrl } from "../lib/pane-nav-outcome";

/** What the sequence needs from the router that owns the sockets and the topics. */
export interface OpenPaneFlowDeps {
  json: (body: unknown, status?: number) => Response;
  broadcastToAll: (message: OutboundMessage) => void;
  /** Resolves true as soon as a pane attaches to the contextId, false at the deadline. */
  waitForAttachedPane: (contextId: string, budgetMs: number) => Promise<boolean>;
  /** How long a pane has to attach, both before navigating and after force-open. */
  paneWaitMs: number;
  /** The localhost-port warning, or undefined when there is nothing to say. */
  portOwnershipWarning: (url: string, callerProjectPath: string | null) => Promise<string | undefined>;
}

export interface OpenPaneFlowOptions {
  contextId: string;
  url: string;
  /** Title to report to the agent; absent = the navigated page's own title. */
  title?: string;
  projectPath: string | null;
  service: BrowserService;
  /** The branch's broadcast. Called again with the final URL on a redirect. */
  announce: (url: string) => void;
  /** `browser:force-open` fallback when no pane attaches (defaults to yes). */
  forceOpen?: boolean;
  /**
   * Does a failed navigation kill the whole call? Yes by default: a chat pane
   * that could not load has produced nothing, and an error is the truth. The
   * task branch says no, because there the tab RECORD is the deliverable and it
   * was already written and announced: answering 500 would tell the agent the
   * tab does not exist while it sits in the drawer. It gets a 200 with the
   * failure in `warning` instead, which is the same information without the lie.
   */
  navigationFatal?: boolean;
}

export function makeOpenPaneFlow(deps: OpenPaneFlowDeps) {
  const { json, broadcastToAll, waitForAttachedPane, portOwnershipWarning } = deps;
  const PANE_WAIT_MS = deps.paneWaitMs;

  /**
   * THE FALLBACK THAT DID NOT EXIST. `browser:force-open` had a type, a Zod
   * schema and a client handler (`usePanelLifecycle`), documented as "when the
   * normal broadcast mounted NO visible pane", and NOBODY emitted it
   * (`tests/unit/ws-outbound-coverage.test.ts` recorded it: "no server
   * emitter"). Seen on 2026-08-11: a live context, a pane never mounted, the
   * user seeing nothing, and the tool answering "Opened browser pane at ..."
   * all the same.
   *
   * Here the fallback is finally armed: after the normal broadcast we wait for
   * a pane to attach to the contextId; if none does, the primary window is
   * asked to open one by force, and we wait again. The boolean that comes back
   * is what makes the route's answer HONEST.
   *
   * Two waits and not an explicit ack because attaching the
   * `/ws/browser/<ctx>` socket IS the signal that the pane exists AND is alive
   * (both the native and the web pane open it), so no new protocol has to live
   * untested next to this one.
   */
  async function forceOpenAndWait(contextId: string, url: string): Promise<boolean> {
    broadcastToAll({ type: "browser:force-open", contextId, url });
    return waitForAttachedPane(contextId, PANE_WAIT_MS);
  }

  /**
   * THE OPENING SEQUENCE, WRITTEN ONCE, FOR ALL THREE BRANCHES.
   *
   * `open-pane` has three origins (chat, board task, terminal) and each one had
   * written its own sequence. The task branch had dropped two steps along the
   * way: it waited for no pane and it never navigated, so it answered "Opened"
   * while the tab sat on `about:blank` and the agent had to force the load by
   * hand with `location.replace` (card 05105d29). Patching the third branch
   * would only have been waiting for the fourth branch to be born with the same
   * hole, so the sequence lives here and the three branches CALL it:
   *
   *   1. ANNOUNCE   the broadcast that mounts/updates the pane. It is the only
   *                 thing that differs between branches (layout pane, drawer
   *                 tab, near-terminal pane);
   *   2. WAIT       for someone to attach to the contextId, BEFORE navigating:
   *                 this is the window in which a native pane can register as
   *                 the delegate, and therefore take the navigation itself
   *                 instead of leaving it to a headless phantom;
   *   3. NAVIGATE   a `browser_open` on the context. It reaches the native pane
   *                 if one registered, otherwise the headless context, which is
   *                 where observe/act will land anyway. This is the step that
   *                 was missing, and it is also what re-navigates an ALREADY
   *                 mounted tab (the client reads `initialUrl` only at mount);
   *   4. CHECK      where the view actually landed: an address it could not
   *                 fetch leaves it on `about:blank` with no error raised by
   *                 anyone, which is a white pane nobody can see from outside
   *                 (card fd64d7a1). Then RE-ANNOUNCE if it redirected, so the
   *                 pane follows the final URL and not the starting one;
   *   5. FALLBACK   if nobody attached, `browser:force-open` with the FINAL URL
   *                 (a forced pane loads its initialUrl and nothing else:
   *                 handing it the starting URL would leave it on the wrong
   *                 page), then wait again.
   *
   * The `visible` boolean that comes out is what makes the answer HONEST: a
   * tool that says "Opened" when it opened nothing is not a navigation defect,
   * it is a tool lying to a caller who has no way to check.
   *
   * The differences between branches stay, but DECLARED as parameters instead
   * of forgotten: `forceOpen` (the task branch turns it off, because a forced
   * standalone pane would take the tab OUTSIDE the drawer, away from where the
   * reviewer looks for it) and `title` (the name prescribed for the tab, or the
   * page title when there is none).
   */
  async function openPaneFlow(opts: OpenPaneFlowOptions): Promise<Response> {
    const { contextId, url, projectPath, service, announce } = opts;
    announce(url);
    const attached = await waitForAttachedPane(contextId, PANE_WAIT_MS);
    let resolvedUrl = url;
    let pageTitle = "";
    let navError = "";
    try {
      const result = (await dispatchBrowserToolCallByContext(
        "browser_open",
        { url },
        contextId,
        service,
      )) as { url?: string; title?: string; error?: string };
      if (result?.error) {
        if (opts.navigationFatal !== false) return json({ error: result.error }, 502);
        navError = result.error;
      }
      if (typeof result?.url === "string" && result.url) resolvedUrl = settledUrl(url, result.url);
      pageTitle = typeof result?.title === "string" ? result.title : "";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.navigationFatal !== false) return json({ error: msg }, 500);
      navError = msg;
    }
    // THE ANSWER IS THE PANE'S, NOT THE REQUEST'S: a view left on the blank page
    // navigated nowhere, and nobody raised an error (pane-nav-outcome.ts). The
    // requested URL stays the one announced and recorded - a tab must point at
    // the document it is for, not at `about:blank` - what changes is that the
    // caller is TOLD.
    const blank = navError ? null : blankPaneFailure(url, resolvedUrl);
    if (blank && opts.navigationFatal !== false) return json({ error: blank }, 502);
    if (blank) { navError = blank; resolvedUrl = url; }
    if (resolvedUrl !== url) announce(resolvedUrl);
    const visible = navError
      ? false
      : attached
        ? true
        : opts.forceOpen === false
          ? false
          : await forceOpenAndWait(contextId, resolvedUrl);
    const portWarning = await portOwnershipWarning(resolvedUrl, projectPath);
    const warning = [navError ? `navigation failed: ${navError}` : "", portWarning ?? ""]
      .filter(Boolean)
      .join(" ");
    return json({
      url: resolvedUrl,
      title: opts.title ?? pageTitle,
      visible,
      ...(warning ? { warning } : {}),
    });
  }

  return openPaneFlow;
}
