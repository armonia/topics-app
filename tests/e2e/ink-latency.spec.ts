/**
 * ink-latency.spec.ts — CLICK → INK on the three most frequent gestures.
 *
 * WHAT IT MEASURES. For each gesture, the milliseconds between the input event
 * and the first frame that has PAINTED the answer:
 *
 *   card    open a board card    → the card's title is readable in the drawer
 *   tab     switch pane tab      → the other chat's own message is readable
 *   send    send a chat message  → the sent message is readable in the list
 *
 * Each target is CONTENT, never a container. A tab switch that reveals an empty
 * box is not a tab switch the user got an answer from, and this app keeps
 * background panes mounted under `display:none` — so a container-shaped target
 * would report the reveal of a box that was already laid out and call it zero.
 * The mechanics (why `event.timeStamp`, why the frame AFTER the DOM is ready,
 * what counts as painted) live in `helpers/ink.ts`.
 *
 * THIS FILE DOES NOT JUDGE. It measures, writes `test-results/ink-latency.json`
 * and asserts only that the HARNESS worked — every gesture produced a real,
 * positive number. The threshold lives in exactly one place,
 * `tests/e2e/ink-budget.json`, and exactly one thing compares against it:
 * `scripts/check-ink-latency.ts`. Two judges reading the same number is how a
 * budget ends up with two values.
 *
 * INK_STALL_MS blocks the main thread on every gesture (see `installInkStall`).
 * It is the falsification lever: it makes the app genuinely slow, so the gate
 * can be seen going red for the reason it exists rather than because a
 * comparison operator was checked against an invented number.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { installInkStall, measureInk, median, type InkSample } from "./helpers/ink";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

/** Ad-hoc board id: the general board aggregates every board, on disk or not (BOARD-07). */
const BOARD_ID = "inkbench-e2e001";
/** Samples per gesture. Odd, so the median is a measured value and not the average of two. */
const SAMPLES = 5;
/** Main-thread stall injected on every gesture — the falsification lever. */
const STALL_MS = Number(process.env.INK_STALL_MS ?? 0);

const OUT_PATH = resolve(__dirname, "../../test-results/ink-latency.json");

interface Measured {
  samples: number[];
  /** Frames observed per sample. Many frames = the app was late; few = the thread was blocked. */
  frames: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
}

const stamp = Date.now();
let topicA: { id: string; name: string };
let topicB: { id: string; name: string };
const seededA = `ink-seed-A-${stamp}`;
const seededB = `ink-seed-B-${stamp}`;
const cardIds: string[] = [];
const cardTitles: string[] = [];

test.describe("INK — click → ink on the three most frequent gestures", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async ({ request }) => {
    topicA = await createTopic(request, `E2E-Ink-A-${stamp}`);
    topicB = await createTopic(request, `E2E-Ink-B-${stamp}`);
    // Both chats start with content, and that is a measurement decision, not
    // convenience. An EMPTY chat pays a one-off cost the moment its list stops
    // being empty: react-virtuoso mounts, applies `initialTopMostItemIndex` and
    // keeps `div[data-virtuoso-item-list]` at `visibility:hidden` until the
    // opening scroll settles. Measured here: the very first message sent into an
    // empty chat is in the DOM at ~22ms and only becomes VISIBLE at ~196ms (24
    // frames), while every later message paints in ~13ms. That is a real cost
    // and it is written down, but it belongs to "a chat opens for the first
    // time", not to "send a message" — averaging it in would hide a 15x
    // regression in the gesture behind one outlier that never changes.
    // `topic:<first 8 chars>` — the session key the server and the client agree
    // on. Seeding under the full uuid writes a session nobody reads.
    await seedMessage(request, { sessionKey: sessionKeyOf(topicA.id), role: "user", content: seededA });
    await seedMessage(request, { sessionKey: sessionKeyOf(topicB.id), role: "user", content: seededB });
    for (let i = 0; i < SAMPLES; i++) {
      const text = `Ink card ${i} ${stamp}`;
      const res = await request.post(`${E2E_BASE}/api/boards/${BOARD_ID}/tasks`, {
        data: { text, status: "todo" },
      });
      expect(res.ok(), "the board API refused to seed a card").toBe(true);
      cardIds.push(((await res.json()) as { id: string }).id);
      cardTitles.push(text);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of cardIds) await deleteTask(request, BOARD_ID, id).catch(() => {});
    for (const t of [topicA, topicB]) if (t) await deleteTopic(request, t.id).catch(() => {});
  });

  test("measures card open, tab switch and message send", async ({ page }, testInfo) => {
    // The workspace is EXACTLY these three tabs: the general board plus two
    // chats. Anything an earlier spec left open would be one more pane to keep
    // resident and would turn the tab number into a measurement of the leftovers.
    await resetPaneStore(page.request, [topicA.id, topicB.id, "__board__"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    if (STALL_MS > 0) await installInkStall(page, STALL_MS);

    const result: Record<string, Measured> = {};
    const record = (key: string, samples: InkSample[]) => {
      const ms = samples.map((s) => s.ms);
      result[key] = {
        samples: ms.map(round1),
        frames: samples.map((s) => s.frames),
        medianMs: round1(median(ms)),
        minMs: round1(Math.min(...ms)),
        maxMs: round1(Math.max(...ms)),
      };
    };

    // ---------------------------------------------------------------- card --
    await page.locator('[data-pane-id="__board__"]').first().click();
    const board = page.getByTestId("kanban-board");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByText(cardTitles[0])).toBeVisible({ timeout: 20_000 });

    const drawer = page.getByTestId("task-detail-drawer");
    const cardSamples: InkSample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      cardSamples.push(
        await measureInk(page, {
          gesture: "pointerdown",
          // The drawer mounts a skeleton while it fetches the task, so the drawer
          // being present is not the answer — the title being readable is.
          target: { selector: '[data-testid="task-detail-drawer"]', text: cardTitles[i] },
          act: () => page.locator(`[data-task-card="${cardIds[i]}"]`).click(),
        }),
      );
      // Closed between samples so every sample measures the same thing: a drawer
      // opening from nothing, not a drawer swapping its contents.
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0, { timeout: 10_000 });
    }
    record("card", cardSamples);

    // ----------------------------------------------------------------- tab --
    const panelOf = (name: string) => `[data-testid="chat-panel"][aria-label="${name} panel"]`;
    const contentOf = (name: string) => `${panelOf(name)} [data-message-id]`;
    // Untimed warm-up: land on A so the first measured switch is A → B, the same
    // shape as every other sample.
    await page.locator(`[data-pane-id="${topicA.id}"]`).first().click();
    await expect(page.locator(contentOf(topicA.name)).first()).toBeVisible({ timeout: 20_000 });

    const tabSamples: InkSample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const to = i % 2 === 0 ? topicB : topicA;
      tabSamples.push(
        await measureInk(page, {
          gesture: "pointerdown",
          target: { selector: contentOf(to.name), text: to === topicA ? seededA : seededB },
          act: () => page.locator(`[data-pane-id="${to.id}"]`).first().click(),
        }),
      );
    }
    record("tab", tabSamples);

    // ---------------------------------------------------------------- send --
    // Land on A and write into A's composer: every resident pane carries its own
    // textarea, so the locator is scoped by the topic's own aria-label.
    await page.locator(`[data-pane-id="${topicA.id}"]`).first().click();
    const panelA = page.locator(panelOf(topicA.name)).first();
    await expect(panelA).toBeVisible({ timeout: 20_000 });
    const composer = panelA.getByRole("textbox", { name: `Message input for ${topicA.name}` });
    await expect(composer).toBeVisible({ timeout: 20_000 });

    const sendSamples: InkSample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const text = `ink-send-${i}-${stamp}`;
      // Typed BEFORE arming: `fill` sets the value without a keydown, but the
      // interval must start at the Enter that sends, not at the typing.
      await composer.fill(text);
      // The session must be IDLE, and the composer is the one that says so: with
      // a turn still in flight the button reads "queue" and Enter parks the text
      // in the outbound queue instead of sending it — by design
      // (composerAction.ts). The bubble then appears when the PREVIOUS turn ends,
      // so the number would be the length of somebody else's turn. Measured
      // before this wait: 194ms and 538ms on the two samples that landed on a
      // live turn, ~13ms on the three that did not.
      await expect(panelA.locator('[data-composer-action="send"]')).toBeVisible({ timeout: 60_000 });
      sendSamples.push(
        await measureInk(page, {
          gesture: "keydown",
          target: { selector: contentOf(topicA.name), text },
          act: () => composer.press("Enter"),
        }),
      );
    }
    record("send", sendSamples);

    // ------------------------------------------------------------- deliver --
    const payload = {
      $schema: "ink-latency-v1",
      measuredAt: new Date().toISOString(),
      samplesPerGesture: SAMPLES,
      stallMs: STALL_MS,
      gestures: result,
    };
    mkdirSync(resolve(__dirname, "../../test-results"), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    testInfo.annotations.push({
      type: "ink",
      description: Object.entries(result)
        .map(([k, v]) => `${k} ${v.medianMs}ms (min ${v.minMs} / max ${v.maxMs})`)
        .join(" · "),
    });

    // Harness sanity ONLY — the budget is judged by scripts/check-ink-latency.ts.
    // A zero here would mean the probe fired before the app did anything, which is
    // the one result a latency measurement must never be allowed to report as success.
    for (const [key, value] of Object.entries(result)) {
      expect(value.samples, `${key}: wrong number of samples`).toHaveLength(SAMPLES);
      expect(value.minMs, `${key}: a sample measured <= 0ms — the probe is lying`).toBeGreaterThan(0);
    }
  });
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The chat session key of a topic: `topic:` + the first 8 chars of its id. */
function sessionKeyOf(topicId: string): string {
  return `topic:${topicId.slice(0, 8)}`;
}
