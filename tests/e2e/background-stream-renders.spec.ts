/**
 * A STREAM FRAME RE-RENDERS ONLY WHAT SHOWS ITS SESSION (BGSTREAM-01).
 *
 * WHAT IT PINS. A turn starting, or a token arriving, in a chat nobody is
 * looking at must not re-render the application. The chat's turn flags
 * (loading, streaming, thinking, stopped) were `useState` in `useChat`, which
 * `App` calls: one `stream:start` of a background topic re-rendered `App` and,
 * through it, the sidebar, every tab bar and every pane (client-speed audit,
 * 30/09, on a copy of a real workspace: 8 commits and 1026 component renders
 * for one frame). They now live in `state/sessionFlags.ts`, and a pane
 * subscribes to its own session.
 *
 * HOW. The frames are delivered to the page's own socket (`dispatchEvent` on
 * the live `WebSocket`), so the app runs its real handler; the server sends
 * nothing. React is observed through the DevTools hook, which the production
 * bundle calls on every commit: the probe counts the components that rendered,
 * and whether `App` itself did. `App` is found by shape, not by name (the bundle
 * is minified): it is the component whose child is `TopicsProvider`, the only
 * component that takes a `terminalRosterAuthoritative` prop.
 *
 * Two sessions: one shown by a pane kept alive behind another tab (that pane
 * may re-render, it shows the session), and one open nowhere, only a row of the
 * sidebar.
 *
 * @covers BGSTREAM-01
 */
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, seedPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ viewport: { width: 1280, height: 800 } });

/**
 * Component renders one frame of a background session may cost, per case.
 * Measured on the WebKit bench (30/09, two runs each), `stream:start`:
 *   - session shown by a hidden pane: 152-156 once the flags left `App` (the
 *     pane itself re-renders: it shows that session), 368 on the base;
 *   - session open nowhere: 32 (its sidebar row), 267 on the base.
 * On the base `App` rendered on both. A token (`content_chunk`) cost the same
 * before and after: 54 and 0.
 */
const FIBER_BUDGET = { "hidden pane": 240, "open nowhere": 120 } as const;

interface ProbeWindow {
  __wsList: WebSocket[];
  __bgStream: { on: boolean; commits: number; fibers: number; appRenders: number };
}

async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ProbeWindow & { WebSocket: typeof WebSocket; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__wsList = [];
    const Native = w.WebSocket;
    w.WebSocket = class extends Native {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        w.__wsList.push(this);
      }
    } as typeof WebSocket;

    type Fiber = { tag: number; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: Record<string, unknown> | null };
    const probe = { on: false, commits: 0, fibers: 0, appRenders: 0 };
    w.__bgStream = probe;
    // Function, class, forwardRef, memo, simple memo: the fibers whose render runs.
    const COMPONENT = new Set([0, 1, 11, 14, 15]);
    const PERFORMED_WORK = 1;
    const isApp = (f: Fiber) => {
      const c = f.child;
      return !!c && COMPONENT.has(c.tag) && !!c.memoizedProps && Object.prototype.hasOwnProperty.call(c.memoizedProps, "terminalRosterAuthoritative");
    };
    const walk = (root: Fiber) => {
      const stack: Fiber[] = [root];
      while (stack.length > 0) {
        const f = stack.pop()!;
        const fresh = f.alternate === null;
        if (COMPONENT.has(f.tag) && (fresh || (f.flags & PERFORMED_WORK) !== 0)) {
          probe.fibers += 1;
          if (isApp(f)) probe.appRenders += 1;
        }
        // Children still shared with the alternate were not reconciled: nothing under them rendered.
        if (fresh || f.child !== f.alternate!.child) for (let c = f.child; c; c = c.sibling) stack.push(c);
      }
    };
    const renderers = new Map<number, unknown>();
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: unknown) {
        const id = renderers.size + 1;
        renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        if (!probe.on) return;
        probe.commits += 1;
        walk(root.current);
      },
    };
  });
}

/** Wait until React has not committed for `quietMs`: the measure must hold only the frame's own renders. */
async function settle(page: Page, quietMs = 800): Promise<void> {
  await page.evaluate(async (quiet) => {
    const p = (window as unknown as ProbeWindow).__bgStream;
    p.commits = 0;
    p.on = true;
    let seen = -1;
    let stillSince = performance.now();
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (p.commits !== seen) { seen = p.commits; stillSince = performance.now(); }
      else if (performance.now() - stillSince >= quiet) break;
    }
    p.on = false;
  }, quietMs);
}

interface FrameCost { commits: number; fibers: number; appRenders: number }

/** Deliver one frame to the page's socket and count what React rendered for it. */
async function deliver(page: Page, frame: Record<string, unknown>): Promise<FrameCost> {
  return page.evaluate(async (f) => {
    const w = window as unknown as ProbeWindow;
    const ws = w.__wsList.filter((s) => s.readyState === 1 && /\/ws(\?|$)/.test(s.url)).pop();
    if (!ws) throw new Error("no open app socket");
    const p = w.__bgStream;
    p.commits = 0; p.fibers = 0; p.appRenders = 0; p.on = true;
    ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(f) }));
    // Whatever the frame schedules lands within a few frames (the token buffer
    // flushes on the next one) and a short timer.
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 250));
    p.on = false;
    return { commits: p.commits, fibers: p.fibers, appRenders: p.appRenders };
  }, frame);
}

async function seedChat(request: APIRequestContext, name: string, rows: number) {
  const t = await createTopic(request, name);
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  const sessionKey = Object.values(topics).find((x) => x.id === t.id)!.sessionKey;
  for (let i = 0; i < rows; i++) {
    await seedMessage(request, { sessionKey, role: i % 2 === 1 ? "assistant" : "user", content: `${name} row ${i}` });
  }
  await unarchiveTopic(request, t.id);
  return { topicId: t.id, sessionKey };
}

test("a stream frame of a background session does not re-render the app", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "BGSTREAM-01" });
  test.setTimeout(120_000);
  const front = await seedChat(request, "BGS front chat", 6);
  const hidden = await seedChat(request, "BGS hidden chat", 6);
  const nowhere = await seedChat(request, "BGS closed chat", 2);
  const openedAt = Date.now();
  await seedPaneStore(request, () => ({
    panes: {
      [hidden.topicId]: { id: hidden.topicId, type: "chat", title: "", topicId: hidden.topicId, openedAt },
      [front.topicId]: { id: front.topicId, type: "chat", title: "", topicId: front.topicId, openedAt },
    },
    groups: { "group:default": { id: "group:default", paneIds: [hidden.topicId, front.topicId], splitRatio: 1, splitAxis: "horizontal" } },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
  await installProbe(page);
  await goToApp(page);
  const tab = (id: string) => page.locator(`[data-testid="panel-tab-bar"] [data-pane-id="${id}"]`).first();
  // Both chats visited once, so the hidden one is mounted behind the front one.
  await tab(hidden.topicId).click();
  await expect(page.locator(`[data-pane-shell="${hidden.topicId}"] [data-testid="chat-message"]`).filter({ hasText: "BGS hidden chat row 5" })).toBeVisible({ timeout: 20_000 });
  await tab(front.topicId).click();
  await expect(page.locator(`[data-pane-shell="${front.topicId}"] [data-testid="chat-message"]`).filter({ hasText: "BGS front chat row 5" })).toBeVisible({ timeout: 20_000 });

  const costs: Array<{ label: string; budget: number } & FrameCost> = [];
  for (const [label, s] of [["hidden pane", hidden], ["open nowhere", nowhere]] as const) {
    const messageId = `bgs-${label.replace(" ", "-")}-${Date.now()}`;
    await settle(page);
    costs.push({ label: `${label} stream:start`, budget: FIBER_BUDGET[label], ...(await deliver(page, { type: "stream:start", sessionKey: s.sessionKey, topicId: s.topicId, messageId })) });
    // The pane that shows the session still hears it, now through its own
    // subscription instead of a render of the whole app: its composer's Send
    // turns into Stop.
    if (label === "hidden pane") await expect(page.locator(`[data-pane-shell="${s.topicId}"] [data-composer-action="stop"]`)).toHaveCount(1);
    await settle(page);
    costs.push({ label: `${label} content_chunk`, budget: FIBER_BUDGET[label], ...(await deliver(page, { type: "stream:content_chunk", sessionKey: s.sessionKey, topicId: s.topicId, content: "tick " })) });
    await settle(page);
    // Close the turn so the next session starts from rest (not measured). A
    // `stream:error` with no error text changes the streaming flag and NO
    // message: only the pane's own subscription to the flags can take its Stop
    // away (a render driven by the message store would hide a missing one).
    await deliver(page, { type: "stream:error", sessionKey: s.sessionKey, topicId: s.topicId });
    if (label === "hidden pane") await expect(page.locator(`[data-pane-shell="${s.topicId}"] [data-composer-action="stop"]`)).toHaveCount(0);
    await deliver(page, { type: "stream:end", sessionKey: s.sessionKey, topicId: s.topicId, messageId });
  }
  const report = costs.map((c) => `${c.label}: ${c.commits} commits, ${c.fibers} renders, App ${c.appRenders}`).join("; ");
  console.log(`[bg-stream] ${report}`);
  for (const c of costs) {
    expect(c.appRenders, `${c.label}: App did not render. ${report}`).toBe(0);
    expect(c.fibers, `${c.label}: component renders within ${c.budget}. ${report}`).toBeLessThanOrEqual(c.budget);
  }
});
