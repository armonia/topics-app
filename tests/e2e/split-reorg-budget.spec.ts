/**
 * REORGANISING THE SPLITS IS INSTANT: NO PANE IS REBUILT, AND A DIVIDER DRAG
 * DOES NOT RENDER PER POINTER MOVE.
 *
 * Attilio, 29/09, asked that reorganising the splits be perfectly instant,
 * performant and fluid. This file turns the three adjectives into
 * counts that do not depend on how loaded the machine is:
 *
 *  - INSTANT: every gesture (split by edge drop, split down, move a pane to
 *    another split, merge into another group, swap two rows, close a split)
 *    changes the tree the DOM publishes by the first animation frame after the
 *    drop, and at the latest by the second.
 *  - NO REBUILD: no pane that was open before the gesture is mounted again. A
 *    remounted terminal re-attaches, a remounted chat re-reads its history and
 *    loses its scroll, a remounted browser reloads: that is the flash. It is
 *    counted twice, independently -- by React itself (a `data-pane-shell` host
 *    node created in a commit while its key already existed) and by the DOM (the
 *    shell node that was there before is no longer the one there after).
 *  - FLUID: during a divider drag of N pointer moves, each laid out on a frame
 *    of its own, the layout commits O(1) times, not N, and no pane body
 *    renders at all. The drag starts from rest (`settlePanes`), so what the
 *    window counts is the drag and nothing still in flight from before.
 *
 * HOW REACT IS OBSERVED: see helpers/react-commit-probe.ts.
 *
 * The timings (pointer to next frame, frame gaps, longtasks) are REPORTED next
 * to the load average and are not the gate: they move with the machine. WebKit
 * has no Long Tasks API, so there the frame gap is the proxy and the line says so.
 *
 * @covers SPLITPERF-01
 */
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { loadavg } from "os";
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  createTerminalSession,
  createTopic,
  deleteTerminalSession,
  deleteTopic,
  resetPaneStore,
  resetProjectPanes,
  seedPaneStore,
  seedProjectPane,
  unarchiveTopic,
} from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir } from "./helpers/file-project";
import { nextFrames } from "./helpers/frame-probe";
import { projectPanesKey } from "../../shared/project-keys";
import { closeTabViaCommand } from "./helpers/layout";
import {
  beginGesture,
  endGesture,
  installProbe,
  QUIET_MS,
  settlePanes,
  type GestureResult,
} from "./helpers/react-commit-probe";

hermetic(test);
// The card asks for a video of the gestures.
test.use({ video: "on" });

/** Pointer moves of the divider drag: large enough that "one commit per move" is unmistakable. */
const DRAG_MOVES = 40;
/** Frames a drop may take to show its new tree (1 = the very next paint). */
const MAX_DROP_FRAMES = 2;
/** Commits the whole divider drag may cost, press and release included. */
const MAX_DRAG_COMMITS = 4;

/** djb2-xor -> base36, mirroring `client/src/lib/dndTypes.ts` paneTabScopeType. */
function paneTabScopeType(scope: string): string {
  let h = 5381;
  for (let i = 0; i < scope.length; i++) h = (((h << 5) + h) ^ scope.charCodeAt(i)) >>> 0;
  return `application/x-pane-scope-${h.toString(36)}`;
}

/** The tree of the project surface as one comparable string: leaves with their tabs. */
async function treeSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const surfaces = document.querySelectorAll("[data-split-surface]");
    const root = surfaces[surfaces.length - 1];
    if (!root) return "";
    return Array.from(root.querySelectorAll("[data-split-leaf]"))
      .map((leaf) => {
        const tabs = Array.from(leaf.querySelectorAll('[data-testid="panel-tab-bar"] [data-pane-id]'))
          .filter((t) => t.closest("[data-split-leaf]") === leaf)
          .map((t) => t.getAttribute("data-pane-id"));
        return `${leaf.getAttribute("data-split-leaf")}[${tabs.join(",")}]`;
      })
      .join(" ");
  });
}

// --- the drag, synthesised: a real `dragstart` on the tab, then the target's events ---

async function startDrag(page: Page, selector: string, scope: string | null, expectType: string | null): Promise<void> {
  await page.evaluate(
    ({ selector, scopeType, expectType }) => {
      const src = document.querySelector(selector);
      if (!src) throw new Error(`no drag source at ${selector}`);
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      if (expectType && !dt.types.includes(expectType)) throw new Error(`dragstart carried no ${expectType}`);
      if (scopeType && !dt.types.includes(scopeType)) dt.setData(scopeType, "1");
      (window as unknown as { __reorgDrag?: { dt: DataTransfer; src: Element } }).__reorgDrag = { dt, src };
    },
    { selector, scopeType: scope ? paneTabScopeType(scope) : null, expectType },
  );
}

async function dragOverPoint(page: Page, at: { x: number; y: number }): Promise<boolean> {
  return page.evaluate((at) => {
    const held = (window as unknown as { __reorgDrag?: { dt: DataTransfer } }).__reorgDrag;
    if (!held) throw new Error("no drag in flight");
    const el = document.elementFromPoint(at.x, at.y);
    if (!el) throw new Error("nothing under the drop point");
    const mk = (type: string) =>
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: held.dt, clientX: at.x, clientY: at.y });
    el.dispatchEvent(mk("dragenter"));
    const over = mk("dragover");
    el.dispatchEvent(over);
    return over.defaultPrevented;
  }, at);
}

/**
 * The release, then the frames it takes for the tree to show it. Resolves with
 * the number of animation frames until the published tree differs from
 * `before` (1 = already changed at the next frame), or -1 if it never did
 * within 120 frames.
 */
async function dropAndCountFrames(page: Page, at: { x: number; y: number }, before: string): Promise<number> {
  return page.evaluate(
    async ({ at, before }) => {
      const held = (window as unknown as { __reorgDrag?: { dt: DataTransfer; src: Element } }).__reorgDrag;
      if (!held) throw new Error("no drag in flight");
      const signature = (): string => {
        const surfaces = document.querySelectorAll("[data-split-surface]");
        const root = surfaces[surfaces.length - 1];
        if (!root) return "";
        return Array.from(root.querySelectorAll("[data-split-leaf]"))
          .map((leaf) => {
            const tabs = Array.from(leaf.querySelectorAll('[data-testid="panel-tab-bar"] [data-pane-id]'))
              .filter((t) => t.closest("[data-split-leaf]") === leaf)
              .map((t) => t.getAttribute("data-pane-id"));
            return `${leaf.getAttribute("data-split-leaf")}[${tabs.join(",")}]`;
          })
          .join(" ");
      };
      const el = document.elementFromPoint(at.x, at.y);
      if (!el) throw new Error("nothing under the drop point");
      const mk = (type: string) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: held.dt, clientX: at.x, clientY: at.y });
      el.dispatchEvent(mk("dragover"));
      el.dispatchEvent(mk("drop"));
      held.src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: held.dt, clientX: at.x, clientY: at.y }));
      (window as unknown as { __reorgDrag?: unknown }).__reorgDrag = undefined;
      // Counted well past the budget, so a slow gesture reports HOW slow
      // instead of just "late".
      for (let frame = 1; frame <= 120; frame++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (signature() !== before) return frame;
      }
      return -1;
    },
    { at, before },
  );
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
}

/** The leaf (group slot) that holds the tab of `paneId`. */
async function leafOf(page: Page, paneId: string): Promise<string> {
  const id = await page.evaluate((pid) => {
    const tab = document.querySelector(`[data-testid="panel-tab-bar"] [data-pane-id="${pid}"]`);
    return tab?.closest("[data-split-leaf]")?.getAttribute("data-split-leaf") ?? null;
  }, paneId);
  if (!id) throw new Error(`no leaf holds ${paneId}`);
  return id;
}

/** The body of the leaf that holds `paneId`: the leaf minus its tab bar. */
async function bodyOf(page: Page, paneId: string) {
  const leaf = await leafOf(page, paneId);
  const cell = await box(page, `[data-split-leaf="${leaf}"]`);
  const bar = await box(page, `[data-split-leaf="${leaf}"] [data-testid="panel-tab-bar"]`);
  const top = bar.y + bar.height;
  return { x: cell.x, y: top, width: cell.width, height: cell.height - (top - cell.y) };
}

function edgePoint(b: { x: number; y: number; width: number; height: number }, edge: "right" | "bottom") {
  const INSET = 10;
  return edge === "right"
    ? { x: b.x + b.width - INSET, y: b.y + b.height / 2 }
    : { x: b.x + b.width / 2, y: b.y + b.height - INSET };
}

const center = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

const tab = (paneId: string) => `[data-testid="panel-tab-bar"] [data-pane-id="${paneId}"]`;

interface Row extends GestureResult {
  gesture: string;
  frames: number;
  /** The chat's scroll offset from the bottom, before -> after (a reading position lost shows here). */
  chatScroll?: string;
}

/** Distance of the chat transcript from its bottom, in px, or null when it has no box. */
async function chatFromBottom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="chat-scroll-container"]');
    if (!el || el.clientHeight === 0) return null;
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });
}

function report(surface: string, rows: Row[], extra: string[]): void {
  const load = loadavg()[0]!.toFixed(2);
  const lines = rows.map(
    (r) =>
      `  ${r.gesture.padEnd(22)} frames=${String(r.frames).padStart(2)} commits=${String(r.commits).padStart(3)} surfaceCommits=${String(r.surfaceCommits).padStart(3)} ` +
      `layoutRenders=${String(r.layoutRenders).padStart(4)} paneRenders=${String(r.paneRenders).padStart(4)} ` +
      `remounts(react)=${r.reactRemounts.length} remounts(dom)=${r.domRemounts.length}` +
      (r.chatScroll ? ` chatFromBottom=${r.chatScroll}` : "") +
      (r.reactRemounts.length || r.domRemounts.length ? ` [${[...new Set([...r.reactRemounts, ...r.domRemounts])].join(" ")}]` : ""),
  );
  const names = rows.map((r) => `  ${r.gesture}: ${r.topNames}`);
  console.log(
    `[split-reorg-budget] ${surface} loadavg(1m)=${load}\n${lines.join("\n")}\n${extra.map((l) => `  ${l}`).join("\n")}\n` +
      `[split-reorg-budget] most rendered components per gesture:\n${names.join("\n")}`,
  );
}

test.describe("split reorganisation budget", () => {
  let dir = "";
  let chatId = "";
  let terminalId = "";

  test.beforeAll(async ({ request }) => {
    dir = canonicalTmpDir("e2e-split-reorg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/README.md`, "# split reorg\n");
    dir = realpathSync(dir);
    const chat = await createTopic(request, `split-reorg-chat-${Date.now()}`, { projectPath: dir });
    chatId = chat.id;
    const res = await request.get(`${E2E_BASE}/api/topics`);
    const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
    const sessionKey = Object.values(topics).find((t) => t.id === chatId)!.sessionKey;
    // A LONG transcript: the chat that loses the most when it is rebuilt.
    for (let i = 0; i < 80; i++) {
      await seedMessage(request, {
        sessionKey,
        role: i % 2 ? "assistant" : "user",
        content: `Message ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8)}`,
      });
    }
    terminalId = (await createTerminalSession(request, { cwd: dir, name: "split-reorg" })).id;
  });

  test.afterAll(async ({ request }) => {
    if (terminalId) await deleteTerminalSession(request, terminalId).catch(() => {});
    if (chatId) await deleteTopic(request, chatId).catch(() => {});
    if (dir) await resetProjectPanes(request, dir).catch(() => {});
  });

  test("every gesture keeps the open panes mounted, and a divider drag does not render per move", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "SPLITPERF-01" });
    test.setTimeout(180_000);

    const chatPane = `chat:${chatId}`;
    const terminalPane = `terminal:${terminalId}`;
    const browserPane = "browser:split-reorg";
    const filesPane = "files:split-reorg";
    const gitPane = "git:split-reorg";

    // The browser pane's stream has no server here: swallow it.
    await page.routeWebSocket(/\/ws\/browser\//, () => {});
    await resetPaneStore(request, []);
    await request
      .put(`${E2E_BASE}/api/ui-state/grid-layout`, { data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] } })
      .catch(() => {});
    await seedProjectPane(request, dir);
    await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(dir)}`, {
      data: {
        nonChatPanes: [
          { id: terminalPane, type: "terminal", title: "Terminal", terminalSessionId: terminalId },
          { id: browserPane, type: "browser", title: "Page", url: "https://example.com/" },
          { id: filesPane, type: "files", title: "Files" },
          { id: gitPane, type: "git", title: "Git" },
        ],
        openChatTopicIds: [chatId],
        activeChatTopicId: chatId,
      },
    });
    await installProbe(page);
    await goToApp(page);

    // Every pane in the project's single group, and each one VISITED so it is
    // mounted: a pane that was never shown is not "open" in the sense that
    // matters, it has nothing to lose.
    for (const id of [terminalPane, browserPane, filesPane, gitPane, chatPane]) {
      await page.locator(tab(id)).first().waitFor({ state: "visible", timeout: 20000 });
    }
    for (const id of [terminalPane, browserPane, filesPane, gitPane, chatPane]) {
      await page.locator(tab(id)).first().click();
      await expect(page.locator(`[data-pane-shell="${id}"]`)).toHaveAttribute("data-pane-visible", "1");
    }
    await page.locator('[data-testid="chat-scroll-container"]').first().waitFor({ state: "visible", timeout: 20000 });

    const scope = dir;
    const rows: Row[] = [];
    const extra: string[] = [];

    async function tabDrop(gesture: string, paneId: string, at: () => Promise<{ x: number; y: number }>) {
      const before = await treeSignature(page);
      const scrollBefore = await chatFromBottom(page);
      const marks = await beginGesture(page);
      await startDrag(page, tab(paneId), scope, "application/x-pane-tab");
      const target = await at();
      const offered = await dragOverPoint(page, target);
      expect(offered, `${gesture}: the target must accept the drop`).toBe(true);
      const frames = await dropAndCountFrames(page, target, before);
      const result = await endGesture(page, marks);
      rows.push({ gesture, frames, ...result, chatScroll: `${scrollBefore}->${await chatFromBottom(page)}` });
    }

    // 1. SPLIT RIGHT: the chat leaves for a column of its own.
    await tabDrop("split-right", chatPane, async () => edgePoint(await bodyOf(page, terminalPane), "right"));
    // 2. SPLIT DOWN: the browser goes under the chat's column.
    await tabDrop("split-down", browserPane, async () => edgePoint(await bodyOf(page, chatPane), "bottom"));
    // 3. MOVE TO ANOTHER SPLIT: git joins the browser's split through its tab bar.
    await tabDrop("move-to-split", gitPane, async () => {
      const t = await box(page, tab(browserPane));
      return { x: t.x + t.width * 0.8, y: t.y + t.height / 2 };
    });
    // 4. MOVE TO ANOTHER GROUP: files merges into the chat's group, dropped on its body.
    await tabDrop("move-to-group", filesPane, async () => center(await bodyOf(page, chatPane)));
    // 5. A SECOND ROW (full-width strip), so there are two rows to swap.
    {
      const before = await treeSignature(page);
      const marks = await beginGesture(page);
      await startDrag(page, tab(gitPane), scope, "application/x-pane-tab");
      await dragOverPoint(page, center(await bodyOf(page, terminalPane)));
      const strip = page.locator('[data-full-row-zone="bottom"]').last();
      await strip.waitFor({ state: "attached", timeout: 5000 });
      const target = center((await strip.boundingBox())!);
      expect(await dragOverPoint(page, target), "full-row: the strip must accept the drop").toBe(true);
      const frames = await dropAndCountFrames(page, target, before);
      rows.push({ gesture: "split-full-row", frames, ...(await endGesture(page, marks)) });
    }
    // 6. SWAP TWO SPLITS: the second row is dragged above the first.
    {
      const before = await treeSignature(page);
      const scrollBefore = await chatFromBottom(page);
      const marks = await beginGesture(page);
      await startDrag(page, '[data-split-surface]:last-of-type [title="Drag to reorder row 2"], [title="Drag to reorder row 2"]', null, null);
      const firstRow = await box(page, `[data-split-leaf="${await leafOf(page, terminalPane)}"]`);
      const target = { x: firstRow.x + firstRow.width / 2, y: firstRow.y + 8 };
      expect(await dragOverPoint(page, target), "swap: the first row must accept the row").toBe(true);
      // The row drop reads the side the dragover chose from committed state,
      // exactly as a real pointer does after hovering: wait for the blade that
      // says it, or a loaded machine releases before the hover has landed.
      await expect(page.locator('[data-group-cell][data-drop-active="before"]').first()).toBeAttached({ timeout: 5000 });
      const frames = await dropAndCountFrames(page, target, before);
      rows.push({
        gesture: "swap-rows",
        frames,
        ...(await endGesture(page, marks)),
        chatScroll: `${scrollBefore}->${await chatFromBottom(page)}`,
      });
    }

    // 7. DIVIDER DRAG, continuous: the column divider between the terminal and the chat.
    {
      const divider = page.locator(`[data-split-leaf="${await leafOf(page, terminalPane)}"]`).locator("xpath=../following-sibling::*[@data-resize-axis='col'][1]");
      await divider.waitFor({ state: "attached", timeout: 5000 });
      const d = (await divider.boundingBox())!;
      const start = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
      await page.evaluate(() => {
        const w = window as unknown as { __reorgFrames: { ts: number[]; moves: number[]; stop: boolean } };
        w.__reorgFrames = { ts: [], moves: [], stop: false };
        const tick = (t: number) => {
          w.__reorgFrames.ts.push(t);
          if (!w.__reorgFrames.stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // performance.now() and not `e.timeStamp`: the two share an origin on
        // paper, and on WebKit the event stamp did not line up with the frame
        // stamps at all (every latency came out undefined).
        window.addEventListener("mousemove", () => w.__reorgFrames.moves.push(performance.now()), { capture: true });
      });
      const settled = await settlePanes(page);
      extra.push(
        `divider drag: pane bodies quiet for ${QUIET_MS}ms after ${settled.ms}ms, ${settled.renders} body renders before that ${settled.names}`,
      );
      const marks = await beginGesture(page);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      // One animation frame after EVERY move, and not `steps`: with `steps`
      // the moves arrive as fast as the machine takes them, so an idle Mac
      // coalesced 40 moves into 14 frames and a loaded one laid out 45, and a
      // render caused by the new width showed up only on the loaded one. Here
      // each move is laid out on its own frame, whatever the load: the worst
      // case, every time.
      for (let i = 1; i <= DRAG_MOVES; i++) {
        await page.mouse.move(start.x - (160 * i) / DRAG_MOVES, start.y);
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      const during = await endGesture(page, marks);
      const releaseMarks = await beginGesture(page);
      await page.mouse.up();
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const release = await endGesture(page, releaseMarks);
      const timing = await page.evaluate(() => {
        const w = window as unknown as { __reorgFrames: { ts: number[]; moves: number[]; stop: boolean } };
        w.__reorgFrames.stop = true;
        const { ts, moves } = w.__reorgFrames;
        const first = moves[0] ?? 0;
        const last = moves[moves.length - 1] ?? 0;
        const inDrag = ts.filter((t) => t >= first && t <= last + 50);
        const gaps = inDrag.slice(1).map((t, i) => t - inDrag[i]!);
        const latency = moves
          .map((m) => (ts.find((t) => t >= m) ?? NaN) - m)
          .filter((x) => Number.isFinite(x))
          .sort((a, b) => a - b);
        const q = (p: number) => latency[Math.min(latency.length - 1, Math.floor(p * latency.length))] ?? NaN;
        const longTaskApi =
          typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask");
        return {
          moves: moves.length,
          frames: inDrag.length,
          maxGap: gaps.length ? Math.max(...gaps) : 0,
          gapsOver50: gaps.filter((g) => g > 50).length,
          p50: q(0.5),
          p95: q(0.95),
          longTaskApi,
        };
      });
      extra.push(`divider drag renders by owner: ${JSON.stringify(during.byOwner)} / release ${JSON.stringify(release.byOwner)}`);
      rows.push({ gesture: "divider-drag(moves)", frames: 0, ...during });
      rows.push({ gesture: "divider-drag(release)", frames: 0, ...release });
      extra.push(
        `divider drag: ${timing.moves} mousemoves, ${timing.frames} frames, max frame gap ${timing.maxGap.toFixed(1)}ms, ` +
          `gaps>50ms ${timing.gapsOver50}, pointer->next frame p50 ${timing.p50.toFixed(1)}ms p95 ${timing.p95.toFixed(1)}ms, ` +
          `longtask API ${timing.longTaskApi ? "yes" : "absent (WebKit): frame gaps are the proxy"}`,
      );
      // Counted on the commits that touched a tiling surface: the status bar or
      // the sidebar ticking during the drag is not the drag's cost.
      expect.soft(
        during.surfaceCommits + release.surfaceCommits,
        `divider drag of ${DRAG_MOVES} moves: commits of the layout`,
      ).toBeLessThanOrEqual(MAX_DRAG_COMMITS);
      expect.soft(during.paneRenders, "divider drag: no pane body renders while the divider moves").toBe(0);
    }

    // 8. CLOSE A SPLIT, with the Close row of the tab's sheet, which closes now
    // (TABSHEET-03): the tab X runs a deliberate undo
    // countdown first (CHROME-12), and that wait is a product decision, not
    // the reorganisation. What is measured is the layout once the close lands.
    {
      await page.locator(tab(gitPane)).first().click({ button: "right" });
      const closeNow = page.getByTestId("tab-sheet-close");
      await closeNow.waitFor({ state: "visible", timeout: 5000 });
      const marks = await beginGesture(page);
      const closeFrames = await page.evaluate(async () => {
        const signature = (): string => {
          const surfaces = document.querySelectorAll("[data-split-surface]");
          const root = surfaces[surfaces.length - 1];
          return Array.from(root?.querySelectorAll("[data-split-leaf]") ?? [])
            .map((l) => l.getAttribute("data-split-leaf"))
            .join(" ");
        };
        const start = signature();
        const btn = document.querySelector<HTMLElement>('[data-testid="tab-sheet-close"]');
        if (!btn) return -2;
        btn.click();
        for (let frame = 1; frame <= 8; frame++) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          if (signature() !== start) return frame;
        }
        return -1;
      });
      rows.push({ gesture: "close-split", frames: closeFrames, ...(await endGesture(page, marks)) });
    }

    report("project grid", rows, extra);

    for (const r of rows) {
      expect.soft(r.reactRemounts, `${r.gesture}: no open pane is mounted again (React)`).toEqual([]);
      expect.soft(r.domRemounts, `${r.gesture}: no open pane shell is replaced (DOM)`).toEqual([]);
      if (!r.gesture.startsWith("divider")) {
        expect.soft(r.frames, `${r.gesture}: the new tree shows by frame ${MAX_DROP_FRAMES}`).toBeGreaterThan(0);
        expect.soft(r.frames, `${r.gesture}: the new tree shows by frame ${MAX_DROP_FRAMES}`).toBeLessThanOrEqual(MAX_DROP_FRAMES);
      }
    }
  });

  test("a countdown close that lands after a split made during the countdown leaves that split and its focus alone", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "SPLITPERF-01" });
    test.setTimeout(120_000);
    // A countdown close runs the close as it was captured when the countdown
    // began. Its rows and focus were reconciled against the groups of THAT
    // moment, so a group made during the 3 s (here: files split under the
    // chat) was missing from them: the close dropped it from the grid, the
    // rows sync appended it again as a column on the right, and the focus
    // fell back to the chat.
    const chatPane = `chat:${chatId}`;
    const filesPane = "files:split-reorg-countdown";
    const gitPane = "git:split-reorg-countdown";
    await resetPaneStore(request, []);
    await request
      .put(`${E2E_BASE}/api/ui-state/grid-layout`, { data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] } })
      .catch(() => {});
    await resetProjectPanes(request, dir);
    await seedProjectPane(request, dir);
    await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(dir)}`, {
      data: {
        nonChatPanes: [
          { id: filesPane, type: "files", title: "Files" },
          { id: gitPane, type: "git", title: "Git" },
        ],
        openChatTopicIds: [chatId],
        activeChatTopicId: chatId,
      },
    });
    await goToApp(page);
    for (const id of [filesPane, gitPane, chatPane]) {
      await page.locator(tab(id)).first().waitFor({ state: "visible", timeout: 20000 });
    }
    for (const id of [filesPane, gitPane, chatPane]) {
      await page.locator(tab(id)).first().click();
      await expect(page.locator(`[data-pane-shell="${id}"]`)).toHaveAttribute("data-pane-visible", "1");
    }

    // 1. Close git WITH the countdown, which lives on the tab's X alone (TABSHEET-03).
    await closeTabViaCommand(page.locator(tab(gitPane)).first());
    const closeClickedAt = Date.now();

    // 2. Inside the countdown: files goes to a split of its own, under the chat, and takes the focus.
    const before = await treeSignature(page);
    await startDrag(page, tab(filesPane), dir, "application/x-pane-tab");
    const target = edgePoint(await bodyOf(page, chatPane), "bottom");
    expect(await dragOverPoint(page, target), "the bottom edge must accept the drop").toBe(true);
    expect(await dropAndCountFrames(page, target, before), "the split did not land").toBeGreaterThan(0);
    await page.locator(tab(filesPane)).first().click();
    await expect(page.locator(`[data-pane-shell="${filesPane}"]`)).toHaveAttribute("data-pane-visible", "1");
    const placeOfFiles = async () => {
      // The pane shells, not the leaves: a leaf id can also name the stack
      // that holds it, whose box covers the whole column.
      const f = await box(page, `[data-pane-shell="${filesPane}"]`);
      const c = await box(page, `[data-pane-shell="${chatPane}"]`);
      if (f.y >= c.y + c.height - 2) return "below the chat";
      if (f.x >= c.x + c.width - 2) return "right of the chat";
      return `elsewhere (${Math.round(f.x)},${Math.round(f.y)})`;
    };
    const placeBefore = await placeOfFiles();
    expect(placeBefore, "the split made during the countdown").toBe("below the chat");
    const focusedClass = await page.locator(tab(filesPane)).first().getAttribute("class");
    expect(Date.now() - closeClickedAt, "the split must land inside the 3 s countdown").toBeLessThan(3000);

    // 3. The countdown ends and the close lands.
    await expect(page.locator(tab(gitPane))).toHaveCount(0, { timeout: 10_000 });
    await nextFrames(page, 20);
    expect(await placeOfFiles(), "the close moved the split made during its countdown").toBe(placeBefore);
    expect(
      await page.locator(tab(filesPane)).first().getAttribute("class"),
      "the close moved the focus off the split made during its countdown",
    ).toBe(focusedClass);
  });

  test("the standalone grid: moving tabs between cells keeps every open pane mounted", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SPLITPERF-01" });
    test.setTimeout(150_000);

    // Two chats of NO project: a project's chat opens inside its project, not
    // as a tab of the standalone grid.
    const first = await createTopic(request, `split-reorg-std-a-${Date.now()}`);
    const other = await createTopic(request, `split-reorg-std-b-${Date.now()}`);
    const res = await request.get(`${E2E_BASE}/api/topics`);
    const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
    const sessionKey = Object.values(topics).find((t) => t.id === first.id)!.sessionKey;
    for (let i = 0; i < 60; i++) {
      await seedMessage(request, {
        sessionKey,
        role: i % 2 ? "assistant" : "user",
        content: `Message ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8)}`,
      });
    }
    const chatA = first.id;
    const chatB = other.id;
    const terminalPane = `terminal:${terminalId}`;
    const browserPane = "browser:split-reorg-std";
    const paneIds = [chatA, chatB, terminalPane, browserPane];
    try {
      await page.routeWebSocket(/\/ws\/browser\//, () => {});
      await Promise.all([chatA, chatB].map((id) => unarchiveTopic(request, id)));
      const openedAt = Date.now();
      await seedPaneStore(request, () => ({
        panes: {
          [chatA]: { id: chatA, type: "chat", title: "", topicId: chatA, openedAt },
          [chatB]: { id: chatB, type: "chat", title: "", topicId: chatB, openedAt },
          [terminalPane]: { id: terminalPane, type: "terminal", title: "Terminal", terminalSessionId: terminalId, openedAt },
          [browserPane]: { id: browserPane, type: "browser", title: "Page", openedAt },
        },
        groups: {
          "group:default": { id: "group:default", paneIds: [...paneIds], splitRatio: 1, splitAxis: "horizontal" },
        },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
      }));
      await request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: paneIds } }).catch(() => {});
      await request
        .put(`${E2E_BASE}/api/ui-state/grid-layout`, { data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] } })
        .catch(() => {});
      // The split cells live in localStorage only: the terminal and the browser
      // each in a cell of their own, the two chats in the pool.
      await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
      await page.evaluate((grid) => {
        localStorage.removeItem("topics-open-panels");
        localStorage.setItem("topics-panel-grid-layout", JSON.stringify(grid));
        localStorage.setItem("topics-panel-grid-layout:space:default", JSON.stringify(grid));
      }, { gridRows: [], gridRowHeights: [], soloCells: [[terminalPane], [browserPane]] });
      await installProbe(page);
      await goToApp(page);
      for (const id of paneIds) await page.locator(tab(id)).first().waitFor({ state: "visible", timeout: 20000 });
      for (const id of [chatB, chatA]) {
        await page.locator(tab(id)).first().click();
        await expect(page.locator(`[data-pane-shell="${id}"]`)).toHaveAttribute("data-pane-visible", "1");
      }

      const rows: Row[] = [];
      const extra: string[] = [];
      async function tabDrop(gesture: string, paneId: string, at: () => Promise<{ x: number; y: number }>) {
        const before = await treeSignature(page);
        const scrollBefore = await chatFromBottom(page);
        const marks = await beginGesture(page);
        await startDrag(page, tab(paneId), "main", "application/x-pane-tab");
        const target = await at();
        expect(await dragOverPoint(page, target), `${gesture}: the target must accept the drop`).toBe(true);
        const frames = await dropAndCountFrames(page, target, before);
        if (frames < 0) console.log(`[split-reorg-budget] ${gesture}: tree unchanged\n  before ${before}\n  after  ${await treeSignature(page)}`);
        rows.push({ gesture, frames, ...(await endGesture(page, marks)), chatScroll: `${scrollBefore}->${await chatFromBottom(page)}` });
      }

      // 1. SPLIT RIGHT: chat B leaves the pool for a cell right of the terminal.
      await tabDrop("split-right", chatB, async () => edgePoint(await bodyOf(page, terminalPane), "right"));
      // 2. MOVE TO ANOTHER CELL: chat B joins the browser's cell as a tab.
      await tabDrop("move-to-cell", chatB, async () => {
        const t = await box(page, tab(browserPane));
        return { x: t.x + t.width * 0.8, y: t.y + t.height / 2 };
      });
      // 3. SPLIT DOWN: chat B leaves that cell for a stack under the terminal.
      await tabDrop("split-down", chatB, async () => edgePoint(await bodyOf(page, terminalPane), "bottom"));
      // 4. MOVE INTO ANOTHER GROUP by its body: chat B merges into the pool, on chat A.
      await tabDrop("move-to-group", chatB, async () => center(await bodyOf(page, chatA)));

      report("standalone grid", rows, extra);
      for (const r of rows) {
        expect.soft(r.reactRemounts, `${r.gesture}: no open pane is mounted again (React)`).toEqual([]);
        expect.soft(r.domRemounts, `${r.gesture}: no open pane shell is replaced (DOM)`).toEqual([]);
        expect.soft(r.frames, `${r.gesture}: the new tree shows by frame ${MAX_DROP_FRAMES}`).toBeGreaterThan(0);
        expect.soft(r.frames, `${r.gesture}: the new tree shows by frame ${MAX_DROP_FRAMES}`).toBeLessThanOrEqual(MAX_DROP_FRAMES);
      }
    } finally {
      await deleteTopic(request, other.id).catch(() => {});
      await deleteTopic(request, first.id).catch(() => {});
    }
  });
});
