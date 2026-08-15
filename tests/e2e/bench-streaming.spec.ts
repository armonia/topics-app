/**
 * THE STREAMING BENCH — what one arriving token costs, and whether that cost
 * grows with the transcript it lands in.
 *
 * WHY THIS EXISTS. `check:scroll-fluidity` scrolls a transcript that is
 * standing still, and `check:ink` times a gesture. Nothing in this repo
 * measures the one thing a chat client does most: absorb a chunk. Three
 * changes landed on that path in August 2026 with no net under them —
 * incremental tool-run coalescing (`coalesceToolRun.ts`), an rAF buffer for
 * `stream:tool_update` (`bufferToolUpdate` in `useChat.ts`), and the split of
 * the live tail from the settled prefix in `MessageList.tsx`. All three exist
 * for the same reason: the per-chunk cost must not scale with how long the
 * conversation already is.
 *
 * SO THAT IS THE MEASUREMENT. The same burst of chunks is driven into a SHORT
 * transcript and into a ~2000-message one, and the interesting number is the
 * RATIO. A client that pays per chunk pays the same in both; a client that
 * re-filters, re-fuses and re-renders the whole transcript on every chunk pays
 * N times more in the long one. That ratio is the product claim of this app
 * written as a number — the same shape as "1 session vs 10 sessions" in the
 * harness this bench is modelled on, with "session" replaced by "the length of
 * the conversation you are already in".
 *
 * THIS FILE DOES NOT JUDGE. It measures, writes
 * `test-results/bench-streaming.json`, and asserts only that the HARNESS
 * worked: every probe resolved, every burst actually landed, the long
 * transcript really was long. The thresholds and the verdict live in exactly
 * one place, `scripts/bench/streaming.ts`. Two readers of one number is how a
 * budget ends up with two values.
 *
 * WHERE EACH PIECE LIVES. This file is the DRIVE: it seeds, it opens the app,
 * it pushes frames in and it waits. The two halves that need no browser are
 * next door, so they can be read and unit-tested without a browser:
 *   the probe (in-page)  tests/e2e/helpers/bench-streaming-probe.ts
 *   the shape (pure)     scripts/bench/streaming-shape.ts
 *   the verdict (pure)   scripts/bench/streaming.ts
 *
 * HOW THE FRAMES GET IN. `helpers/ws-helpers.ts` → `interceptWebSocket`, the
 * one established way this suite injects `stream:*` frames (see
 * `turn-awaiting-input.spec.ts`, `empty-turn-on-stop.spec.ts`). `messageId` is
 * mandatory on `stream:start`: a frame without it is dropped by
 * `validateInbound` in silence, and the bubble never appears.
 *
 * THE FALSIFICATION KNOB. `TOPICS_STREAM_ON2_US_PER_MSG=<µs>` makes the client
 * burn `µs × transcript-length` microseconds inside the task that parses each
 * arriving chunk — which is exactly the defect the three fixes removed. It is
 * `installOn2Knob` in the probe file, which explains where it lands and why.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arch, cpus, platform, release } from "node:os";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp, openTopic } from "./helpers";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  installOn2Knob,
  installProbe,
  type ArmOptions,
  type On2Knob,
} from "./helpers/bench-streaming-probe";
import {
  buildStreamingReport,
  round2,
  round4,
  shapeBurst,
  shapeQuiet,
  summarise,
  type BenchMode,
  type BurstResult,
  type Calibration,
  type QuietBaseline,
  type ScenarioResult,
} from "../../scripts/bench/streaming-shape";

hermetic(test);

/** Chunks per burst. One burst is "a model talking without stopping". */
const CHUNKS = Number(process.env.TOPICS_BENCH_STREAM_CHUNKS || 1000);
/** Bursts per scenario. Odd, so the median is a measured value. */
const REPS = Number(process.env.TOPICS_BENCH_STREAM_REPS || 3);
/** The long transcript. ~2000 messages is a real working chat, measured on the live DB. */
const LONG_MESSAGES = Number(process.env.TOPICS_BENCH_STREAM_MESSAGES || 2000);
/** The control. Short enough that no O(N) cost can hide in it. */
const SHORT_MESSAGES = 6;
/**
 * One content delta, in characters. Fixed width IS the counter: the painted
 * text of the live bubble divided by this is exactly how many chunks the
 * client has applied, with no parsing and no ambiguity. Letters only — a
 * markdown-significant character would let `closeOpenTokens` add text that
 * nobody sent.
 */
const TOKEN = "tick";
/**
 * How long the occupancy probe watches an idle page before the bench starts.
 * Its output is the two constants the burst numbers are read against: how fast
 * a zero-delay task can come back on THIS machine, and how late it gets when
 * nothing at all is happening.
 */
const CALIBRATION_MS = 600;
/**
 * How long one burst is allowed to take before the probe closes it and reports
 * how far the client got. A healthy client finishes 1500 chunks in well under a
 * second; this ceiling exists so a client that CANNOT keep up produces a number
 * instead of a timeout.
 */
const BURST_DEADLINE_MS = Number(process.env.TOPICS_BENCH_STREAM_DEADLINE_MS || 20_000);
/** Microseconds of per-chunk work per transcript message. 0 = the knob is off. */
const ON2_US_PER_MESSAGE = Number(process.env.TOPICS_STREAM_ON2_US_PER_MSG || 0);

const OUT_PATH = resolve(
  process.env.TOPICS_BENCH_STREAM_OUT?.trim() || "test-results/bench-streaming.json",
);

const scenarios: Record<string, ScenarioResult> = {};
const witness: Record<string, number> = {};
const quiet: Record<string, QuietBaseline> = {};

/* ────────────────────────────────────────────────────────────── seeding ── */

/**
 * A transcript with the SHAPE the real DB has: one question, three work-only
 * assistant rows (one tool each, empty prose), one answer. Measured on the live
 * database, 85% of assistant messages are exactly "one tool call, no text" —
 * and that is the shape `coalesceToolRuns` exists to fuse, so a bench seeded
 * with plain paragraphs would leave the fuser with nothing to do and would
 * measure a cost nobody pays.
 *
 * `id`, `parentId` and `sortOrder` are explicit, and the inserts go out ONE AT A
 * TIME. Both halves are forced: leaving the parent implicit makes the endpoint
 * default it to "the last row of this session", so concurrent writers chain
 * onto each other and leave sibling roots — a thread the client renders
 * truncated. And `messages.parent_id` is a real foreign key onto `messages.id`
 * (migration 005), so a batch sent in parallel fails with a 500 the moment a
 * child reaches SQLite before its parent. Measured: ~2000 rows in a few
 * seconds, which is cheaper than either of those two ways of being wrong.
 */
async function seedTranscript(
  request: APIRequestContext,
  sessionKey: string,
  count: number,
  tag: string,
): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(`${tag}-${String(i).padStart(5, "0")}`);
  const base = Date.parse("2026-08-01T09:00:00.000Z");

  for (let i = 0; i < count; i++) {
    const slot = i % 5;
    const body =
      slot === 0
        ? {
            role: "user",
            content:
              `[${tag} ${i}] And what about the ${i}th thing? ` +
              "Please look at the file and tell me what it does.",
          }
        : slot === 4
          ? {
              role: "assistant",
              content:
                `[${tag} ${i}] Here is what I found. ` +
                "The module keeps its own copy of the state and reconciles it on load. ".repeat(3),
            }
          : {
              role: "assistant",
              // Work-only: empty prose plus one tool. See the note above.
              content: "",
              toolCalls: [
                {
                  id: `${tag}-tc-${i}`,
                  name: slot === 1 ? "Bash" : slot === 2 ? "Read" : "Grep",
                  args: { command: `rg --line-number "thing-${i}" server/` },
                  status: "success",
                  result: `line ${i}: matched\n`.repeat(3),
                },
              ],
            };
    const res = await request.post(`${E2E_BASE}/api/test/seed-message`, {
      ignoreHTTPSErrors: true,
      data: {
        ...body,
        sessionKey,
        id: ids[i],
        parentId: i === 0 ? null : ids[i - 1],
        sortOrder: 1000 + i,
        timestamp: new Date(base + i * 1000).toISOString(),
      },
    });
    if (!res.ok()) {
      throw new Error(`seed-message refused row ${i}: ${res.status()} ${await res.text()}`);
    }
  }
}

/* ─────────────────────────────────────────────────────────────── bursts ── */

interface WsSender {
  send(data: string): void;
}

/**
 * The same watch, with no chunks in it.
 *
 * "Does anything outside the message list move while a chunk lands" is not a
 * question a raw count can answer: the sidebar's device readout and the turn
 * timer tick on their own clocks, so a burst-only number blames the stream for
 * a wall clock. This is the subtrahend.
 */
async function runQuiet(
  page: Page,
  o: { messageId: string; toolCallId: string; calibration: Calibration; windowMs: number },
): Promise<QuietBaseline> {
  await page.evaluate(
    (opts: ArmOptions) => window.__benchStream?.arm(opts),
    {
      mode: "text",
      messageId: o.messageId,
      toolCallId: o.toolCallId,
      tokenChars: TOKEN.length,
      target: Number.MAX_SAFE_INTEGER,
      blockedFloorMs: Math.max(1, round2(o.calibration.p95DelayMs * 2)),
      deadlineMs: o.windowMs,
      quietWindowMs: o.windowMs,
    } satisfies ArmOptions,
  );
  await page.evaluate(() => window.__benchStream?.mark());
  await expect
    .poll(async () => page.evaluate(() => window.__benchStream?.settled() ?? false), {
      timeout: 60_000,
      message: "the quiet window never elapsed",
    })
    .toBe(true);
  return shapeQuiet(await page.evaluate(() => window.__benchStream?.read()), o.calibration);
}

async function runBurst(
  page: Page,
  ws: WsSender,
  opts: {
    mode: BenchMode;
    sessionKey: string;
    topicId: string;
    messageId: string;
    toolCallId: string;
    /** Chunks already applied before this burst (bursts share one live turn). */
    alreadyApplied: number;
    calibration: Calibration;
  },
): Promise<BurstResult> {
  const target = opts.alreadyApplied + CHUNKS;
  // The floor is the 95th percentile of what a zero-delay task waits on an idle
  // page HERE, never a constant: a fixed 4 ms floor reports zero stalls on a
  // fast machine and a permanent stall on a slow one.
  const blockedFloorMs = Math.max(1, round2(opts.calibration.p95DelayMs * 2));
  await page.evaluate(
    (o: ArmOptions) => window.__benchStream?.arm(o),
    {
      mode: opts.mode,
      messageId: opts.messageId,
      toolCallId: opts.toolCallId,
      tokenChars: TOKEN.length,
      target,
      blockedFloorMs,
      deadlineMs: BURST_DEADLINE_MS,
      quietWindowMs: 0,
    } satisfies ArmOptions,
  );

  // A chatty tool ships its whole output again on every update: the handler
  // REPLACES `result` rather than appending, which is what makes the rAF buffer
  // lossless. Kept to a tail window so the payload stays the size a live
  // `tail -f` produces rather than growing without bound.
  const toolTailLines: string[] = [];
  const handoffStart = performance.now();
  for (let k = 0; k < CHUNKS; k++) {
    const index = opts.alreadyApplied + k + 1;
    if (opts.mode === "text") {
      ws.send(
        JSON.stringify({
          type: "stream:content_chunk",
          sessionKey: opts.sessionKey,
          topicId: opts.topicId,
          content: TOKEN,
        }),
      );
    } else {
      toolTailLines.push(`  ${index} · resolved dependency and wrote the artefact`);
      if (toolTailLines.length > 200) toolTailLines.shift();
      ws.send(
        JSON.stringify({
          type: "stream:tool_update",
          sessionKey: opts.sessionKey,
          topicId: opts.topicId,
          toolCallId: opts.toolCallId,
          partialResult: `[k=${String(index).padStart(6, "0")}]\n${toolTailLines.join("\n")}`,
        }),
      );
    }
  }
  const handoffMs = performance.now() - handoffStart;

  // HANDOFF IS NOT ARRIVAL, and the mark is what separates them.
  //
  // `WebSocketRoute.send` returns without waiting for the frame to reach the
  // page, so the loop above times the DRIVER, not the delivery. This evaluate
  // rides the same connection behind every frame already queued, so the page
  // clock it stamps is "the driver has no more to give" — and
  // `tComplete - tMark` is the backlog the client still had to work through.
  await page.evaluate(() => window.__benchStream?.mark());

  // Waits for the burst to CLOSE, not for it to succeed: it closes either when
  // the last chunk is painted or when the deadline runs out, and both of those
  // are measurements.
  await expect
    .poll(async () => page.evaluate(() => window.__benchStream?.settled() ?? false), {
      timeout: BURST_DEADLINE_MS + 60_000,
      message: `the ${opts.mode} burst never closed`,
    })
    .toBe(true);

  const raw = await page.evaluate(() => window.__benchStream?.read());
  return shapeBurst(raw, {
    mode: opts.mode,
    chunks: CHUNKS,
    handoffMs,
    calibration: opts.calibration,
  });
}

/**
 * Every scenario of one transcript, on one page: the text bursts first, then
 * the tool bursts, all inside ONE live turn.
 *
 * One turn and not one per burst, because `stream:end` does not reliably clear
 * `partial` (it only rewrites the bubble when `cleanInvisibleMarkers` changed
 * something), and a `stream:start` that lands on a still-partial bubble is
 * skipped as a duplicate — the next burst would then append to the previous
 * bubble and the counter would read the wrong thing. Bursts therefore share a
 * bubble and count cumulatively.
 */
async function measureTranscript(
  page: Page,
  request: APIRequestContext,
  o: { topicId: string; topicName: string; sessionKey: string; messages: number; label: "short" | "long" },
): Promise<void> {
  await resetPaneStore(request, [o.topicId]);
  const ws = await interceptWebSocket(page);
  if (ON2_US_PER_MESSAGE > 0) await page.addInitScript(installOn2Knob);
  await page.addInitScript(installProbe);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(o.topicName));

  const scroller = page
    .locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]')
    .first();
  await scroller.waitFor({ state: "visible", timeout: 30_000 });

  // THE TRANSCRIPT REALLY IS THE LENGTH THIS BENCH CLAIMS.
  //
  // Everything here compares a long conversation against a short one; if the
  // client silently loaded the last fifty messages, both numbers would describe
  // the same thing and the ratio would be a flat 1.0 forever. The scroll run of
  // the virtualized list is the client-side proof that the whole thread is in
  // the store, and it is recorded in the JSON so a reader can see it too.
  //
  // The floor is DERIVED from the seed (10 px a message, well under the ~26 px
  // a fused tool row actually occupies) so that shrinking the bench for a smoke
  // run does not quietly turn this witness off. It applies to the LONG
  // transcript only: the control is meant to fit on one screen, and demanding a
  // scroll run there would be demanding that the control stop being a control.
  if (o.label === "long") {
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 60_000 })
      .toBeGreaterThan(o.messages * 10);
  }
  const runPx = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
  witness[`${o.label}_scroll_run_px`] = Math.round(runPx);
  witness[`${o.label}_transcript_messages`] = o.messages;

  // The zero of every main-thread number below, taken on THIS page while it is
  // idle and BEFORE the knob is switched on: a baseline measured under the
  // defect would widen exactly as the defect got worse.
  const calibration = await page.evaluate(
    (ms: number) => window.__benchStream?.calibrate(ms),
    CALIBRATION_MS,
  );
  if (!calibration || calibration.idleRatePerMs <= 0) {
    throw new Error("bench probe: the occupancy probe could not be calibrated on this page");
  }
  witness[`${o.label}_idle_probe_pings_per_ms`] = round2(calibration.idleRatePerMs);
  witness[`${o.label}_idle_probe_p95_delay_ms`] = round4(calibration.p95DelayMs);

  // The knob reads this on every parsed frame. Setting `messages` per
  // transcript is what makes the injected defect proportional to the
  // conversation, which is the whole shape of the regression it reproduces.
  await page.evaluate(
    (knob: On2Knob) => {
      window.__benchOn2 = knob;
    },
    { usPerMessage: ON2_US_PER_MESSAGE, messages: o.messages } satisfies On2Knob,
  );

  const messageId = `bench-stream-${o.label}-${Date.now()}`;
  const toolCallId = `bench-tool-${o.label}-${Date.now()}`;
  ws.send({ type: "stream:start", sessionKey: o.sessionKey, topicId: o.topicId, messageId });
  const bubble = page.locator(`[data-testid="chat-message"][data-message-id="${messageId}"]`);
  await expect(bubble).toHaveCount(1, { timeout: 30_000 });

  // ---- text deltas -------------------------------------------------------
  // One chunk must paint before the probe can count: `.prose` does not exist
  // inside an empty bubble, and arming against a selector that is not there yet
  // reads -1 and calls the burst unmeasurable.
  ws.send({
    type: "stream:content_chunk",
    sessionKey: o.sessionKey,
    topicId: o.topicId,
    content: TOKEN,
  });
  await expect(bubble.locator(".prose")).toHaveCount(1, { timeout: 30_000 });

  quiet[o.label] = await runQuiet(page, { messageId, toolCallId, calibration, windowMs: 1000 });

  // The cursor is where the last burst CLOSED, never `rep * CHUNKS`: a burst
  // cut short by the deadline leaves a backlog, and assuming it landed in full
  // would make every later burst count chunks that are still queued.
  const textRuns: BurstResult[] = [];
  let textCursor = 1;
  for (let r = 0; r < REPS; r++) {
    const run = await runBurst(page, ws, {
      mode: "text",
      sessionKey: o.sessionKey,
      topicId: o.topicId,
      messageId,
      toolCallId,
      alreadyApplied: textCursor,
      calibration,
    });
    textCursor = run.applied_at_end;
    textRuns.push(run);
  }
  scenarios[`text_${o.label}`] = summarise("text", o.label, o.messages, CHUNKS, textRuns);

  // ---- tool updates ------------------------------------------------------
  ws.send({
    type: "stream:tool_call",
    sessionKey: o.sessionKey,
    topicId: o.topicId,
    toolCall: {
      id: toolCallId,
      name: "Bash",
      args: { command: "bun run build" },
      status: "running",
    },
  });
  const toolRow = page.locator(`[data-testid="tool-call-row-${toolCallId}"]`);
  await expect(toolRow).toHaveCount(1, { timeout: 30_000 });
  ws.send({
    type: "stream:tool_update",
    sessionKey: o.sessionKey,
    topicId: o.topicId,
    toolCallId,
    partialResult: "[k=000000]\n  0 · starting",
  });
  await expect(toolRow).toContainText("[k=000000]", { timeout: 30_000 });

  const toolRuns: BurstResult[] = [];
  let toolCursor = 0;
  for (let r = 0; r < REPS; r++) {
    const run = await runBurst(page, ws, {
      mode: "tool",
      sessionKey: o.sessionKey,
      topicId: o.topicId,
      messageId,
      toolCallId,
      alreadyApplied: toolCursor,
      calibration,
    });
    toolCursor = run.applied_at_end;
    toolRuns.push(run);
  }
  scenarios[`tool_${o.label}`] = summarise("tool", o.label, o.messages, CHUNKS, toolRuns);
}

/* ─────────────────────────────────────────────────────────────── the run ── */

test.describe.serial("BENCH — what a streamed chunk costs", () => {
  test.describe.configure({ timeout: 900_000 });

  const stamp = Date.now();
  let longTopic = { id: "", name: "", sessionKey: "" };
  let shortTopic = { id: "", name: "", sessionKey: "" };

  test.beforeAll(async ({ request }) => {
    const sessionKeyOf = async (id: string): Promise<string> => {
      const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
      const body = (await res.json()) as {
        topics: Record<string, { id: string; sessionKey?: string }>;
      };
      const key = body.topics?.[id]?.sessionKey;
      // Read, never rebuilt: a changed convention must break here loudly
      // instead of making the bench inject frames nobody collects.
      if (!key) throw new Error(`topic ${id} has no sessionKey — the bench cannot inject frames`);
      return key;
    };

    const long = await createTopic(request, `bench-stream-long-${stamp}`);
    longTopic = { id: long.id, name: long.name, sessionKey: await sessionKeyOf(long.id) };
    const short = await createTopic(request, `bench-stream-short-${stamp}`);
    shortTopic = { id: short.id, name: short.name, sessionKey: await sessionKeyOf(short.id) };

    // The tag carries the run stamp because the seeded ids are EXPLICIT (see
    // `seedTranscript`): the E2E database survives between runs, so a fixed tag
    // makes the second run collide on the primary key and the seed 500s.
    await seedTranscript(request, longTopic.sessionKey, LONG_MESSAGES, `L${stamp}`);
    await seedTranscript(request, shortTopic.sessionKey, SHORT_MESSAGES, `S${stamp}`);
  });

  test.afterAll(async ({ request }) => {
    for (const t of [longTopic, shortTopic]) {
      if (t.id) await deleteTopic(request, t.id).catch(() => {});
    }
  });

  test("absorbs a burst into a long transcript", async ({ page, request }) => {
    await measureTranscript(page, request, {
      topicId: longTopic.id,
      topicName: longTopic.name,
      sessionKey: longTopic.sessionKey,
      messages: LONG_MESSAGES,
      label: "long",
    });
  });

  test("absorbs the same burst into a short one", async ({ page, request }) => {
    await measureTranscript(page, request, {
      topicId: shortTopic.id,
      topicName: shortTopic.name,
      sessionKey: shortTopic.sessionKey,
      messages: SHORT_MESSAGES,
      label: "short",
    });
  });

  test("writes the report", async () => {
    const payload = buildStreamingReport({
      on2UsPerMessage: ON2_US_PER_MESSAGE,
      machine: {
        platform: `${platform()} ${release()}`,
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        cores: cpus().length,
      },
      protocol: {
        chunks_per_burst: CHUNKS,
        reps: REPS,
        token_chars: TOKEN.length,
        calibration_ms: CALIBRATION_MS,
        burst_deadline_ms: BURST_DEADLINE_MS,
        long_transcript_messages: LONG_MESSAGES,
        short_transcript_messages: SHORT_MESSAGES,
      },
      witness,
      quiet,
      scenarios,
    });

    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    // Reached only if `buildStreamingReport` found all four scenarios: it
    // throws on a missing one rather than serialising a hole.
    const rate = (key: string): number => scenarios[key].median.absorbed_per_s;
    console.log(
      `[bench-streaming] text ${rate("text_long")}/s long vs ` +
        `${rate("text_short")}/s short · tool ` +
        `${rate("tool_long")}/s vs ${rate("tool_short")}/s ` +
        `-> ${OUT_PATH}`,
    );

    // Harness sanity ONLY. The budget belongs to scripts/bench/streaming.ts.
    // A zero anywhere here means a probe reported success without measuring,
    // which is the one result a bench must never publish.
    for (const [key, scenario] of Object.entries(scenarios)) {
      expect(scenario.runs, `${key}: wrong number of bursts`).toHaveLength(REPS);
      expect(scenario.median.absorbed_per_s, `${key}: absorbed nothing`).toBeGreaterThan(0);
      expect(scenario.median.frames, `${key}: the frame probe collected nothing`).toBeGreaterThan(0);
    }
    expect(witness.long_transcript_messages, "the long transcript was never measured").toBe(
      LONG_MESSAGES,
    );
    expect(
      witness.long_scroll_run_px,
      "the long transcript did not produce a long list: the client did not load it all",
    ).toBeGreaterThan(LONG_MESSAGES * 10);
  });
});
