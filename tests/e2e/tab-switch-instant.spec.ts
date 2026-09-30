/**
 * A TAB SWITCH IS INSTANT (TABSWITCH-01).
 *
 * WHAT IT PINS. The owner's ask: switching tab must be instant. Two contracts,
 * one per kind of pane the switch lands on:
 *
 *  - RESIDENT (mounted, hidden behind another tab): its final content is on the
 *    FIRST frame after the input, with no spinner or skeleton in between, the
 *    same shell node (nothing remounted), no request for its data, no jump
 *    after that frame, a bounded number of React commits, and no history row
 *    replaying the entrance meant for a message that just arrived. Same bar for
 *    a click on the tab, Ctrl+Tab, the sidebar row and the command palette.
 *  - NON-RESIDENT (a chat in another group, which the switch mounts): the first
 *    frame already holds the skeleton or the content, never an empty pane; no
 *    empty frame between the skeleton and the content; no jump once the content
 *    is there; no entrance replay.
 *
 * WHY THE BUDGETS ARE FRAME COUNTS AND NOT MILLISECONDS. The suite runs on
 * machines under load, where a frame can take 60 ms: "within 100 ms" would be
 * red for the machine, not for the app. "On the first frame after the input"
 * holds on any machine, and so do remount, request and commit counts.
 *
 * What it caught on the base (tab-switch audit 2026-09-29): every return to a
 * chat kept alive behind another tab painted the list 107 px too low on its
 * first frame and then jumped (the hidden pane had stored its 0x0 box as the
 * composer's height), and history rows replayed the entrance animation.
 */
import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, seedPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beginGesture, endGesture, installProbe, settlePanes } from "./helpers/react-commit-probe";

hermetic(test);
test.use({ viewport: { width: 1280, height: 800 } });

/**
 * A real agent thread: far more than the first history page (40), so the rest
 * is merged while the pane is hidden, with tool rows measured late. At 120 rows
 * neither defect below showed; at 2000 both did (tab-switch audit).
 */
const LONG_COUNT = 2000;
const SHORT_COUNT = 30;
/** Frames watched after the content lands, to catch a late jump or a regression. */
const TAIL_FRAMES = 12;
/**
 * React commits a resident switch may cost. Measured 6-9 after the fix and 7-14
 * on the base; the cap is on the count, which load does not change.
 */
const RESIDENT_COMMIT_CAP = 14;

const tab = (paneId: string) => `[data-testid="panel-tab-bar"] [data-pane-id="${paneId}"]`;

interface FrameReport {
  /** One letter per frame: C content, S skeleton or spinner, . neither. */
  seq: string;
  firstContent: number | null;
  jumpPx: number;
  entrances: number;
  sameShell: boolean;
  skeletonBox: { top: number; bottom: number } | null;
  trace: string[];
}

/** The per-frame meter, armed before the input and started by it (capture phase). */
async function installMeter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const SPIN = '[data-testid="chat-skeleton"], .animate-spin';
    const shown = (el: Element): boolean => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (n.getAttribute("data-pane-visible") === "0") return false;
        const st = (n as HTMLElement).style;
        if (st && (st.display === "none" || st.visibility === "hidden")) return false;
      }
      return true;
    };
    type Cfg = { key: string; needle: string; trigger: string; triggerKey?: string };
    const w = window as unknown as Record<string, unknown>;
    w.__tabSwitchArm = (cfg: Cfg) => {
      const escapedKey = CSS.escape(cfg.key);
      const shellBefore = document.querySelector(`[data-pane-shell="${escapedKey}"]`);
      const out = {
        done: false,
        seq: "",
        firstContent: null as number | null,
        jumpPx: 0,
        entrances: 0,
        sameShell: false,
        skeletonBox: null as { top: number; bottom: number } | null,
        trace: [] as string[],
      };
      w.__tabSwitchOut = out;
      let firstTop: number | null = null;
      const tick = (frame: number) => {
        const shell = document.querySelector(`[data-pane-shell="${escapedKey}"]`);
        let content: Element | null = null;
        let spin = false;
        if (shell) {
          for (const m of Array.from(shell.querySelectorAll('[data-testid="chat-message"]'))) {
            if ((m.textContent ?? "").includes(cfg.needle) && shown(m)) content = m;
          }
          for (const s of Array.from(shell.querySelectorAll(SPIN))) {
            if (!shown(s)) continue;
            spin = true;
            if (!out.skeletonBox && s.getAttribute("data-testid") === "chat-skeleton") {
              const r = s.getBoundingClientRect();
              out.skeletonBox = { top: Math.round(r.top), bottom: Math.round(r.bottom) };
            }
          }
          // A running entrance on a row of this pane: history replaying the
          // animation of a message that just arrived.
          for (const a of document.getAnimations()) {
            const t = (a.effect as KeyframeEffect | null)?.target;
            if (a.playState === "running" && (a as CSSAnimation).animationName === "messageSlideIn" && t && shell.contains(t)) out.entrances += 1;
          }
        }
        const ok = !!content && !spin;
        out.seq += ok ? "C" : spin ? "S" : ".";
        if (ok && out.firstContent === null) out.firstContent = frame;
        if (ok) {
          const top = Math.round(content!.getBoundingClientRect().top);
          if (firstTop === null) firstTop = top;
          else out.jumpPx = Math.max(out.jumpPx, Math.abs(top - firstTop));
        }
        if (out.trace.length < 30) {
          const items = shell?.querySelector('[data-testid="virtuoso-item-list"]');
          const scroller = shell?.querySelector('[data-testid="chat-message-list"]') as HTMLElement | null;
          const geometry = scroller ? ` st=${scroller.scrollTop.toFixed(1)}/${scroller.scrollHeight}/${scroller.clientHeight}` : "";
          out.trace.push(`${frame}${out.seq.slice(-1)}:it=${items ? items.childElementCount : -1}${content ? `@${content.getBoundingClientRect().top.toFixed(1)}` : ""}${geometry}`);
        }
        const enough = out.firstContent !== null ? frame >= out.firstContent + (w.__tabSwitchTail as number) : frame >= 180;
        if (enough) {
          out.sameShell = !!shellBefore && shellBefore === document.querySelector(`[data-pane-shell="${escapedKey}"]`);
          out.done = true;
          return;
        }
        requestAnimationFrame(() => tick(frame + 1));
      };
      const onTrigger = (e: Event) => {
        if (cfg.triggerKey && (e as KeyboardEvent).key !== cfg.triggerKey) return;
        window.removeEventListener(cfg.trigger, onTrigger, true);
        requestAnimationFrame(() => tick(1));
      };
      window.addEventListener(cfg.trigger, onTrigger, true);
    };
  });
}

interface Switch {
  report: FrameReport;
  commits: number;
  reactRemounts: string[];
  domRemounts: string[];
  requests: string[];
}

/**
 * One measured switch: settle, arm the meter, act, wait for the meter. Requests
 * are the ones that name the target's data (its history, its topic): a status
 * poll that happens to fire inside the window is not the switch's.
 */
async function measureSwitch(
  page: Page,
  target: { key: string; needle: string; topicId: string; sessionKey: string },
  trigger: { event: string; key?: string },
  act: () => Promise<void>,
): Promise<Switch> {
  await settlePanes(page);
  const marks = await beginGesture(page);
  await page.evaluate(
    ([cfg, tail]) => {
      const w = window as unknown as { __tabSwitchArm: (c: unknown) => void; __tabSwitchTail: number };
      w.__tabSwitchTail = tail as number;
      w.__tabSwitchArm(cfg);
    },
    [{ key: target.key, needle: target.needle, trigger: trigger.event, triggerKey: trigger.key }, TAIL_FRAMES] as const,
  );
  const requests: string[] = [];
  const onRequest = (r: { url: () => string; method: () => string }) => {
    const u = decodeURIComponent(r.url());
    if (u.includes(target.topicId) || u.includes(target.sessionKey)) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  };
  page.on("request", onRequest);
  await act();
  await page.waitForFunction(() => (window as unknown as { __tabSwitchOut?: { done: boolean } }).__tabSwitchOut?.done === true, null, { timeout: 30_000 });
  page.off("request", onRequest);
  const report = (await page.evaluate(() => (window as unknown as { __tabSwitchOut: FrameReport }).__tabSwitchOut)) as FrameReport;
  const g = await endGesture(page, marks);
  return { report, commits: g.commits, reactRemounts: g.reactRemounts, domRemounts: g.domRemounts, requests };
}

async function seedChat(request: APIRequestContext, name: string, count: number, endMarker: string, withTools = false) {
  const t = await createTopic(request, name);
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  const sessionKey = Object.values(topics).find((x) => x.id === t.id)!.sessionKey;
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    await seedMessage(request, {
      sessionKey,
      role: i % 2 === 1 ? "assistant" : "user",
      // Some rows tall, some short: a list whose geometry has to be measured.
      content: last ? `${endMarker} final line` : `Row ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(i % 5 === 0 ? 8 : 2)}`,
      // Tool rows too, as in a real agent thread: they are measured late.
      toolCalls:
        withTools && i % 2 === 1 && !last
          ? [
              { id: `tc-${i}-a`, name: "Bash", args: { command: `ls -la /tmp/${i}` }, status: "success", result: `total ${i}\nfile-${i}.txt` },
              { id: `tc-${i}-b`, name: "Read", args: { file_path: `/tmp/f${i}.ts` }, status: "success", result: `export const x${i} = ${i};` },
            ]
          : undefined,
    });
  }
  await unarchiveTopic(request, t.id);
  return { topicId: t.id, sessionKey };
}

function expectResident(label: string, s: Switch): void {
  const r = s.report;
  const detail = `${label}: seq=${r.seq} trace=${r.trace.join(" ")} commits=${s.commits} requests=${s.requests.join(",")}`;
  expect(r.firstContent, `${label}: content on the first frame after the input. ${detail}`).toBe(1);
  expect(r.seq, `${label}: no frame without the content after it landed. ${detail}`).toMatch(/^C+$/);
  expect(r.jumpPx, `${label}: nothing moves after the first frame. ${detail}`).toBe(0);
  expect(r.sameShell, `${label}: the same shell node, not a remount. ${detail}`).toBe(true);
  expect([...s.reactRemounts, ...s.domRemounts], `${label}: no pane remounted. ${detail}`).toEqual([]);
  expect(s.requests, `${label}: nothing asked to the server for a pane already on the page. ${detail}`).toEqual([]);
  expect(s.commits, `${label}: React commits under the cap. ${detail}`).toBeLessThanOrEqual(RESIDENT_COMMIT_CAP);
  expect(r.entrances, `${label}: no history row replays the entrance. ${detail}`).toBe(0);
}

test.describe("a tab switch is instant", () => {
  test("a resident chat is final on the first frame, by click, Ctrl+Tab, sidebar row and palette", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSWITCH-01" });
    test.setTimeout(180_000);
    const long = await seedChat(request, "TSI long chat", LONG_COUNT, "LONG-END", true);
    const short = await seedChat(request, "TSI short chat", SHORT_COUNT, "SHORT-END");
    const openedAt = Date.now();
    await seedPaneStore(request, () => ({
      panes: {
        [long.topicId]: { id: long.topicId, type: "chat", title: "", topicId: long.topicId, openedAt },
        [short.topicId]: { id: short.topicId, type: "chat", title: "", topicId: short.topicId, openedAt },
      },
      groups: { "group:default": { id: "group:default", paneIds: [long.topicId, short.topicId], splitRatio: 1, splitAxis: "horizontal" } },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
    await installProbe(page);
    await installMeter(page);
    await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
    await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), short.topicId);
    await goToApp(page);
    const shortRow = page.locator(`[data-pane-shell="${short.topicId}"] [data-testid="chat-message"]`).filter({ hasText: "SHORT-END" });
    const longRow = page.locator(`[data-pane-shell="${long.topicId}"] [data-testid="chat-message"]`).filter({ hasText: "LONG-END" });
    await page.locator(tab(short.topicId)).first().click();
    await expect(shortRow).toBeVisible({ timeout: 20_000 });
    // First visit of the long chat (cold, not measured), then away from it: the
    // rest of its history is merged while it is hidden.
    await page.locator(tab(long.topicId)).first().click();
    await expect(longRow).toBeVisible({ timeout: 20_000 });
    await page.locator(tab(short.topicId)).first().click();
    await expect(shortRow).toBeVisible();
    await expect(page.locator(`[data-pane-shell="${long.topicId}"] [data-testid="chat-message-list"]`)).toHaveAttribute("data-history", "complete", { timeout: 20_000 });

    const L = { key: long.topicId, needle: "LONG-END", ...long };
    const S = { key: short.topicId, needle: "SHORT-END", ...short };
    const CLICK = { event: "click" };
    expectResident("click, back to the long chat", await measureSwitch(page, L, CLICK, () => page.locator(tab(long.topicId)).first().click()));
    expectResident("Ctrl+Tab", await measureSwitch(page, S, { event: "keydown", key: "Tab" }, () => page.keyboard.press("Control+Tab")));
    expectResident("Ctrl+Shift+Tab", await measureSwitch(page, L, { event: "keydown", key: "Tab" }, () => page.keyboard.press("Control+Shift+Tab")));
    const sideRow = (name: string) => page.locator('[aria-label="Topics sidebar"]').getByText(name, { exact: true }).first();
    expectResident("sidebar row", await measureSwitch(page, S, CLICK, () => sideRow("TSI short chat").click()));
    const palette = page.getByTestId("command-palette");
    await page.keyboard.press("Meta+k");
    await expect(palette).toBeVisible();
    await page.keyboard.type("TSI long chat");
    await expect(palette).toContainText("TSI long chat");
    expectResident("command palette", await measureSwitch(page, L, { event: "keydown", key: "Enter" }, () => page.keyboard.press("Enter")));
  });

  test("a chat in another group shows its skeleton on the first frame and lands without a jump", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSWITCH-02" });
    test.setTimeout(180_000);
    const main = await seedChat(request, "TSI main chat", LONG_COUNT, "MAIN-END", true);
    const other = await seedChat(request, "TSI other group chat", SHORT_COUNT, "OTHER-END");
    const SPACE = "tsi-space-2";
    const openedAt = Date.now();
    await seedPaneStore(request, () => ({
      panes: {
        [main.topicId]: { id: main.topicId, type: "chat", title: "", topicId: main.topicId, openedAt },
        [other.topicId]: { id: other.topicId, type: "chat", title: "", topicId: other.topicId, openedAt, spaceId: SPACE },
      },
      groups: { "group:default": { id: "group:default", paneIds: [main.topicId, other.topicId], splitRatio: 1, splitAxis: "horizontal" } },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
      spaces: { [SPACE]: { id: SPACE, name: "TSI Group", order: 1, updatedAt: openedAt } },
    }));
    await installProbe(page);
    await installMeter(page);
    await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
    await page.evaluate((id) => localStorage.setItem("pane-store-focused-id", id), main.topicId);
    await goToApp(page);
    await expect(page.locator(`[data-pane-shell="${main.topicId}"] [data-testid="chat-message"]`).filter({ hasText: "MAIN-END" })).toBeVisible({ timeout: 20_000 });

    const M = { key: main.topicId, needle: "MAIN-END", ...main };
    const O = { key: other.topicId, needle: "OTHER-END", ...other };
    const CLICK = { event: "click" };
    const toOther = await measureSwitch(page, O, CLICK, () => page.getByTestId("space-row").filter({ hasText: "TSI Group" }).first().click());
    const back = await measureSwitch(page, M, CLICK, () => page.getByTestId("space-row").first().click());
    for (const [label, s] of [["to the other group", toOther], ["back to the first group", back]] as const) {
      const r = s.report;
      const detail = `${label}: seq=${r.seq} trace=${r.trace.join(" ")}`;
      expect(r.seq[0], `${label}: the first frame holds the skeleton or the content, never an empty pane. ${detail}`).not.toBe(".");
      expect(r.seq, `${label}: skeleton, then content, and nothing empty in between. ${detail}`).toMatch(/^S*C+$/);
      expect(r.jumpPx, `${label}: no jump once the content is there. ${detail}`).toBe(0);
      expect(r.entrances, `${label}: no history row replays the entrance. ${detail}`).toBe(0);
    }
  });
});
