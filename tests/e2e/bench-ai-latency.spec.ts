/**
 * bench-ai-latency.spec.ts - AI RESPONSE TIME, split into the part that is ours
 * and the part that is not.
 *
 * WHY THE SPLIT IS THE WHOLE POINT. Topics has no model. It drives Claude Code,
 * Codex and other CLI agents over a PTY, so "how fast is the AI" is a question
 * about somebody else's product and publishing one number for it under our name
 * would be dishonest. What is ours, completely, is the overhead we add on that
 * path, and that overhead is what a user feels as "snappy" or "sluggish". So
 * this file measures four intervals and NEVER adds them together:
 *
 *   composerToWire        Enter keydown  -> POST /api/chat leaves the client
 *                         OURS. Composer handler, state update, and the request
 *                         body build. This path used to serialise the ENTIRE
 *                         transcript into the body (fixed by
 *                         client/src/hooks/chatRequestPayload.ts), which is
 *                         exactly the kind of cost that grows quietly with the
 *                         length of a conversation. `requestBodyChars` is
 *                         recorded next to it so a regression shows up as size
 *                         and not only as milliseconds.
 *
 *   wireToAccepted        that POST     -> the server's `message:new` frame is
 *                         back at the client
 *                         OURS. The 409 in-flight gate, the SQLite write of the
 *                         user row (`appendLocalMessage`), the broadcast, and
 *                         one full WebSocket hop. Measured at the client's own
 *                         socket, so the transport is inside the number.
 *
 *   firstTokenToInk       a provider event reaches the app -> the first token is
 *                         READABLE
 *                         OURS. What people mean by "it started answering":
 *                         placeholder bubble, reducer, React, paint.
 *
 *   midStreamTokenToInk   same, for a token appended to a bubble that is already
 *                         on screen. Cheaper by construction, and it is the one
 *                         that runs hundreds of times per turn.
 *
 *   acceptedToFirstProviderEvent
 *                         NOT OURS. The model and the network. Zero by
 *                         construction in the default mode, because the default
 *                         mode does not call a model at all. It is reported as
 *                         "not measured" and never as a zero.
 *
 * HOW IT AVOIDS SPENDING TOKENS. A benchmark that costs money per run stops
 * being run. Two things keep the default mode free, and neither is a promise:
 *
 *   The send legs use the real server, and everything they measure happens
 *   BEFORE a provider is resolved: the user row is written and broadcast at the
 *   top of the handler (server/routes/chat.ts). The turn then continues into the
 *   CLI, which on the isolated E2E server has its own HOME and is therefore not
 *   logged in, so it closes on "Not logged in" with model `<synthetic>`
 *   (measured 2026-08-15: seven turns, zero tokens). That is not assumed. Every
 *   run records the model named on each `stream:end` under
 *   `models_that_answered`, so a run that DID reach a provider says so in its own
 *   output instead of quietly costing money.
 *
 *   The delivery legs never touch a provider at all: they are driven by
 *   `stream:*` frames injected at the client's WebSocket, the same instrument
 *   chat-inflight-bubble-identity.spec.ts uses.
 *
 * `BENCH_AI_REAL=1` opts in to a real provider for the one leg that needs one.
 * It does not trust `/api/providers/snapshot`, which called openclaw,
 * claude-code and gemini all "ready" on a server where none of them could
 * answer: "ready" means configured, not logged in. It probes with one turn and
 * reads the model back. See `reachedAModel`.
 *
 * WHY THE FRAMES ARE INJECTED INSIDE THE PAGE, not from the Playwright route
 * layer. A frame sent from a `routeWebSocket` handler crosses the driver
 * process boundary, and that hop is the harness, not the app. Here t0 is a
 * `performance.now()` taken in the page on the same thread that will run the
 * reducer, one statement before the frame is dispatched onto the app's live
 * socket. The mechanics are `injectAndPaint` in helpers/bench-ai-probe.ts.
 *
 * WHAT THIS IS NOT. `ink-latency.spec.ts` already owns "press Enter until the
 * SENT message is readable" (median 12.4 ms, tests/e2e/ink-budget.json). That
 * is the user's own bubble, painted optimistically by the client. It shares
 * only its first instant with `composerToWire` and has nothing to do with the
 * AI's answer. The two numbers cannot contradict each other because they end at
 * different events.
 *
 * THIS FILE DOES NOT JUDGE. It measures and writes bench/results/ai-latency.json.
 * The verdict lives in scripts/bench/ai-latency.ts, for the reason ink-latency
 * gives: one number judged in two places is how a budget ends up with two
 * values. The asserts here are harness sanity only.
 *
 * WHERE EACH PIECE LIVES. This file is the DRIVE: it seeds, it types, it presses
 * Enter and it waits. The halves that need no browser are next door, so they can
 * be read and unit-tested without a browser:
 *   the probe (in-page)  tests/e2e/helpers/bench-ai-probe.ts
 *   the shape (pure)     scripts/bench/ai-latency-shape.ts
 *   the verdict (pure)   scripts/bench/ai-latency.ts
 *
 * FALSIFICATION. Three env knobs make OUR half genuinely slow, so the harness
 * can be seen catching a regression instead of only ever being green:
 *   BENCH_AI_SEND_STALL_MS     blocks the main thread on keydown, ahead of
 *                              React's handler -> inflates composerToWire
 *   BENCH_AI_DELIVER_STALL_MS  blocks it when a WS frame arrives, ahead of the
 *                              app's onmessage -> inflates both ink legs
 *   BENCH_AI_ACCEPT_STALL_MS   holds the POST in flight -> inflates
 *                              wireToAccepted
 * They live with the probe they arm, and the third is installed only when
 * non-zero: the route interception it needs costs a driver round-trip per
 * request and would itself be a tax on the baseline.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { installAcceptStall, installProbe, type BenchWant } from "./helpers/bench-ai-probe";
import { buildAiLatencyReport, shapeModelLeg } from "../../scripts/bench/ai-latency-shape";

hermetic(test);

/** Samples per interval. Odd, so the median is a measured value and not the average of two. */
const SAMPLES = 7;
/**
 * Samples in real-provider mode. Fewer on purpose: every one of them is a paid
 * turn against a live model, and this leg is not ours to defend anyway. Three is
 * enough for a median and a range that say whether the provider was warm.
 */
const REAL_SAMPLES = 3;

const REAL_MODE = process.env.BENCH_AI_REAL === "1";
const SEND_STALL_MS = Number(process.env.BENCH_AI_SEND_STALL_MS ?? 0);
const DELIVER_STALL_MS = Number(process.env.BENCH_AI_DELIVER_STALL_MS ?? 0);
const ACCEPT_STALL_MS = Number(process.env.BENCH_AI_ACCEPT_STALL_MS ?? 0);

const OUT_DIR = resolve(__dirname, "../../bench/results");
/**
 * Same two files, same names, same snake_case keys as the sibling harness that
 * had already landed when this was written (scripts/bench/memory.ts writes
 * `memory-<platform>-<date>.json` plus `memory-latest.json`): a dated copy that
 * accumulates, and a stable name the judge and the runner read.
 */
const OUT_LATEST = resolve(OUT_DIR, "ai-latency-latest.json");
const OUT_DATED = (): string =>
  resolve(OUT_DIR, `ai-latency-${platform()}-${new Date().toISOString().slice(0, 10)}.json`);

/** Every assistant bubble in the transcript. Text makes each match unique. */
const ASSISTANT_BUBBLE = '[data-testid="chat-message"][data-role="assistant"]';
/** Ceiling for one ink measurement before it is reported as "never painted". */
const INK_TIMEOUT_MS = 15_000;

const stamp = Date.now();
let topicId = "";
let topicName = "";
let sessionKey = "";

test.describe("BENCH - AI response time, our overhead separated from the model's", () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async ({ request }) => {
    topicName = `E2E-BenchAI-${stamp}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;

    const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const body = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    const found = Object.values(body.topics).find((t) => t.id === topicId);
    expect(found, "the created topic is not in /api/topics").toBeTruthy();
    sessionKey = found!.sessionKey;
    expect(sessionKey, "a topic without a sessionKey cannot receive stream frames").toBeTruthy();

    // TWO exchanges, not zero and not one, and both halves of that matter.
    // An EMPTY chat pays a one-off cost the first time its list stops being
    // empty: react-virtuoso mounts and MessageList holds the list hidden behind
    // a skeleton for LIST_REVEAL_FLOOR_MS. ink-budget.json measured that at
    // ~355 ms against ~13 ms for every later message, and folding it in would
    // park a permanent outlier inside the range forever. And a single user
    // message puts the session in the branch where a stop WIPES the chat
    // (decideClientWipeOnStop), which is not the branch this file is measuring.
    await seedMessage(request, { sessionKey, role: "user", content: `bench-seed-q-${stamp}` });
    await seedMessage(request, { sessionKey, role: "assistant", content: `bench-seed-a-${stamp}` });
    await seedMessage(request, { sessionKey, role: "user", content: `bench-seed-q2-${stamp}` });
    await seedMessage(request, { sessionKey, role: "assistant", content: `bench-seed-a2-${stamp}` });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test("measures send overhead, delivery overhead, and the model's share", async ({ page, request }, testInfo) => {
    // EXACTLY one pane. Anything an earlier spec left open is one more resident
    // chat competing for the same main thread, and every number here is a
    // main-thread number.
    await resetPaneStore(page.request, [topicId]);

    await installProbe(page, { sendStallMs: SEND_STALL_MS, deliverStallMs: DELIVER_STALL_MS });
    if (ACCEPT_STALL_MS > 0) await installAcceptStall(page, ACCEPT_STALL_MS);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
    await page.locator(`[data-pane-id="${topicId}"]`).first().click();

    const panel = page.locator(`[data-testid="chat-panel"][aria-label="${topicName} panel"]`).first();
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const composer = panel.getByRole("textbox", { name: `Message input for ${topicName}` });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    // The seeded transcript must be PAINTED before anything is timed. Until the
    // reveal floor elapses the list is there but hidden, and a first sample
    // taken across that curtain would measure the curtain.
    await expect(panel.locator("[data-message-id]").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.__benchAi?.openSockets() ?? 0), {
      timeout: 20_000,
      message: "the app never opened its WebSocket, so nothing could be injected into it",
    }).toBeGreaterThan(0);

    const providers = await readyProviders(request);

    // ------------------------------------------------------------ send legs --
    const composerToWire: number[] = [];
    const wireToAccepted: number[] = [];
    const bodyChars: number[] = [];
    const acceptedToProvider: number[] = [];

    const turnModels: string[] = [];

    const sendSamples = REAL_MODE ? REAL_SAMPLES : SAMPLES;
    // One untimed send first. The very first POST of a page pays connection
    // setup and a cold code path in the composer; it is a real cost, but it is
    // "the first message of a session", not "sending a message".
    const warmup = await sendOnce(page, panel, composer, promptFor(`bench-warmup-${stamp}`), `bench-warmup-${stamp}`, {
      wantProviderEvent: REAL_MODE,
    });
    turnModels.push(warmup.turnModel ?? "none");

    // In real mode, the warm-up is also the PROBE. If it never reached a model
    // there is nothing to measure and no reason to pay for two more turns to
    // find that out again.
    const modelIsReachable = !REAL_MODE || reachedAModel(warmup.turnModel);

    for (let i = 0; i < sendSamples; i++) {
      const marker = `bench-send-${i}-${stamp}`;
      const sample = await sendOnce(page, panel, composer, promptFor(marker), marker, {
        wantProviderEvent: REAL_MODE && modelIsReachable,
      });
      composerToWire.push(sample.composerToWireMs);
      wireToAccepted.push(sample.wireToAcceptedMs);
      bodyChars.push(sample.bodyChars);
      turnModels.push(sample.turnModel ?? "none");
      if (sample.acceptedToProviderMs !== null) acceptedToProvider.push(sample.acceptedToProviderMs);
    }

    // -------------------------------------------------------- delivery legs --
    // Run AFTER the send legs, never interleaved: an injected `stream:start`
    // makes the client believe a turn is in flight, and the composer would park
    // the next send in the outbound queue instead of sending it.
    //
    // "disabled" is the idle-and-empty state of the one composer button, so it
    // is the assertion that the last real turn is over. A busy composer with an
    // empty field reads "stop" instead.
    await expect(panel.locator('[data-composer-action="disabled"]')).toBeVisible({ timeout: 60_000 });

    const firstToken: number[] = [];
    const midStream: number[] = [];

    // Untimed injected turn, same reason as the untimed send.
    await injectedTurn(page, `bench-warm-first-${stamp}`, `bench-warm-mid-${stamp}`);

    for (let i = 0; i < SAMPLES; i++) {
      const sample = await injectedTurn(page, `bench-ink-first-${i}-${stamp}`, `bench-ink-mid-${i}-${stamp}`);
      firstToken.push(sample.firstMs);
      midStream.push(sample.midMs);
    }

    // ------------------------------------------------------------- deliver ---
    const payload = buildAiLatencyReport({
      real: REAL_MODE,
      platform: `${platform()} ${arch()}`,
      machine: `${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores, ${platform()} ${release()}`,
      shell: `${testInfo.project.use.browserName ?? "chromium"} headless 1280x800`,
      samples: { send: sendSamples, delivery: SAMPLES },
      stalls: { send: SEND_STALL_MS, deliver: DELIVER_STALL_MS, accept: ACCEPT_STALL_MS },
      providersReady: providers,
      turnModels,
      legs: {
        composerToWire,
        wireToAccepted,
        firstTokenToInk: firstToken,
        midStreamTokenToInk: midStream,
      },
      modelLeg: shapeModelLeg({
        real: REAL_MODE,
        modelIsReachable,
        probeModel: warmup.turnModel,
        providersReady: providers,
        samples: acceptedToProvider,
      }),
      bodyChars,
    });

    mkdirSync(OUT_DIR, { recursive: true });
    const serialised = `${JSON.stringify(payload, null, 2)}\n`;
    writeFileSync(OUT_LATEST, serialised);
    writeFileSync(OUT_DATED(), serialised);

    testInfo.annotations.push({
      type: "bench-ai",
      description:
        `send ${payload.metrics.composerToWire.medianMs}ms + accept ${payload.metrics.wireToAccepted.medianMs}ms · ` +
        `first token ${payload.metrics.firstTokenToInk.medianMs}ms · mid-stream ${payload.metrics.midStreamTokenToInk.medianMs}ms`,
    });

    // Harness sanity ONLY. The budget is judged by scripts/bench/ai-latency.ts.
    // A zero here would mean a probe fired before the app did anything, which is
    // the one result a latency measurement must never report as success.
    for (const key of ["composerToWire", "wireToAccepted", "firstTokenToInk", "midStreamTokenToInk"] as const) {
      const m = payload.metrics[key];
      expect(m.samples, `${key}: wrong number of samples`).toHaveLength(key === "composerToWire" || key === "wireToAccepted" ? sendSamples : SAMPLES);
      expect(m.minMs, `${key}: a sample measured <= 0 ms, the probe is lying`).toBeGreaterThan(0);
    }
    expect(Math.max(...bodyChars), "the request body is empty, so the send leg measured nothing").toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * What goes in the composer. The marker is what makes the turn findable in the
 * `message:new` frame; in real mode the text around it is kept to the shortest
 * instruction that still produces a token, because every one of those turns is
 * paid for.
 */
function promptFor(marker: string): string {
  return REAL_MODE ? `Reply with the single word ok. ${marker}` : marker;
}

/** Which providers this server claims it could call. See `reachedAModel`. */
async function readyProviders(request: import("@playwright/test").APIRequestContext): Promise<string[]> {
  const res = await request.get(`${E2E_BASE}/api/providers/snapshot`, { ignoreHTTPSErrors: true }).catch(() => null);
  if (!res?.ok()) return [];
  const body = (await res.json()) as { providers?: Array<{ name?: string; status?: string }> };
  return (body.providers ?? []).filter((p) => p.status === "ready" && p.name).map((p) => p.name!);
}

interface SendSample {
  composerToWireMs: number;
  wireToAcceptedMs: number;
  bodyChars: number;
  acceptedToProviderMs: number | null;
  /** What `stream:end` said the turn ran on. `<synthetic>` means no model was called. */
  turnModel: string | null;
}

/**
 * A turn that never reached a model still emits every stream frame: the server
 * mints the placeholder, writes the provider's refusal into it and closes. The
 * ONLY field that tells the two apart is the model on `stream:end`.
 *
 * On the isolated E2E server this is the normal case and it is what keeps the
 * default mode free: `scripts/start-test-server.sh` gives the server its own
 * HOME, so the `claude` CLI under it is not logged in and answers
 * "Not logged in - Please run /login" with model `<synthetic>` (measured
 * 2026-08-15, seven turns, zero tokens). A gate that trusted
 * `/api/providers/snapshot` instead would be fooled: it reported openclaw,
 * claude-code and gemini all "ready" on that same server, because "ready" means
 * "configured", not "logged in".
 */
function reachedAModel(model: string | null): boolean {
  return model !== null && model.length > 0 && !model.startsWith("<");
}

/**
 * One send, measured at three points: the keydown, the fetch call, and the
 * server's `message:new` coming back over the socket.
 *
 * The composer must read "send" before the key is pressed. With a turn still in
 * flight the button reads "queue" and Enter parks the text in the outbound queue
 * instead of sending it (composerAction.ts), so the measurement would be the
 * length of somebody else's turn.
 */
async function sendOnce(
  page: import("@playwright/test").Page,
  panel: import("@playwright/test").Locator,
  composer: import("@playwright/test").Locator,
  text: string,
  marker: string,
  opts: { wantProviderEvent: boolean },
): Promise<SendSample> {
  // Typed with `fill`, which sets the value without a keydown: the interval has
  // to start at the Enter that sends, not at the typing. It also has to come
  // FIRST, because the single composer button is "disabled" while the field is
  // empty and only becomes "send" once there is something to submit
  // (composerAction.ts). Waiting for "send" on an empty composer waits forever.
  await composer.fill(text);
  await expect(panel.locator('[data-composer-action="send"]')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => window.__benchAi?.reset());
  await composer.press("Enter");

  const read = () =>
    page.evaluate((m: string) => {
      const bench = window.__benchAi;
      if (!bench) return null;
      const state = bench.read();
      const accepted = state.frames.find(
        (f) => f.type === "message:new" && (f.content ?? "").includes(m),
      );
      // The provider boundary is the first CONTENT chunk, not `stream:start`.
      // `stream:start` is the server minting a placeholder row on its way to the
      // provider, so counting it would credit the model with our own work.
      const firstChunk = state.frames.find((f) => f.type === "stream:content_chunk");
      const ended = state.frames.find((f) => f.type === "stream:end");
      const send = state.sends[0] ?? null;
      return {
        keydownAt: state.keydownAt,
        fetchAt: send?.at ?? null,
        bodyChars: send?.bodyChars ?? null,
        acceptedAt: accepted?.at ?? null,
        providerAt: firstChunk?.at ?? null,
        endedAt: ended?.at ?? null,
        model: ended?.model ?? null,
      };
    }, marker);

  await expect
    .poll(async () => (await read())?.acceptedAt !== null, {
      timeout: 30_000,
      message: `the server never broadcast message:new for ${marker}`,
    })
    .toBe(true);

  // Wait for the turn to CLOSE, always. It is the only frame that names the
  // model, and without that name a run cannot say whether it called one.
  await expect
    .poll(async () => (await read())?.endedAt !== null, {
      timeout: opts.wantProviderEvent ? 180_000 : 60_000,
      message: `the turn for ${marker} never ended`,
    })
    .toBe(true);

  const got = await read();
  expect(got, "the page probe is gone").toBeTruthy();
  expect(got!.keydownAt, "no keydown was captured, so the interval has no start").not.toBeNull();
  expect(got!.fetchAt, "no POST /api/chat was seen leaving the client").not.toBeNull();

  return {
    composerToWireMs: got!.fetchAt! - got!.keydownAt!,
    wireToAcceptedMs: got!.acceptedAt! - got!.fetchAt!,
    bodyChars: got!.bodyChars ?? 0,
    turnModel: got!.model,
    // Only credited when the turn actually reached a model. A turn that was
    // refused at the CLI still produces a content chunk within milliseconds, and
    // publishing that as "the model's share" would be the exact lie this file
    // exists to avoid.
    acceptedToProviderMs:
      opts.wantProviderEvent && reachedAModel(got!.model) && got!.providerAt !== null && got!.providerAt > got!.acceptedAt!
        ? got!.providerAt - got!.acceptedAt!
        : null,
  };
}

/**
 * One injected turn: `stream:start` plus its first token, then a second token,
 * then the close.
 *
 * The first interval covers both the start and the first chunk, dispatched back
 * to back in the same task. That is the honest shape of "it started answering":
 * a user does not see a placeholder, they see the first word.
 *
 * `stream:start` carries a `messageId` because the client validates every
 * inbound frame against shared/ws-outbound.ts and drops the ones that do not
 * fit, in silence outside DEV.
 */
async function injectedTurn(
  page: import("@playwright/test").Page,
  firstText: string,
  midText: string,
): Promise<{ firstMs: number; midMs: number }> {
  const messageId = `bench-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  const base = { sessionKey, topicId };
  const start = JSON.stringify({ ...base, type: "stream:start", messageId });
  const chunkOne = JSON.stringify({ ...base, type: "stream:content_chunk", content: firstText });
  const chunkTwo = JSON.stringify({ ...base, type: "stream:content_chunk", content: ` ${midText}` });
  const end = JSON.stringify({ ...base, type: "stream:end", messageId });

  const first = await page.evaluate(
    ({ raws, want }: { raws: string[]; want: BenchWant }) => window.__benchAi!.injectAndPaint(raws, want),
    { raws: [start, chunkOne], want: { selector: ASSISTANT_BUBBLE, text: firstText, timeoutMs: INK_TIMEOUT_MS } },
  );
  const mid = await page.evaluate(
    ({ raws, want }: { raws: string[]; want: BenchWant }) => window.__benchAi!.injectAndPaint(raws, want),
    { raws: [chunkTwo], want: { selector: ASSISTANT_BUBBLE, text: midText, timeoutMs: INK_TIMEOUT_MS } },
  );
  await page.evaluate((raw: string) => window.__benchAi!.injectRaw(raw), end);

  return { firstMs: first.ms, midMs: mid.ms };
}
