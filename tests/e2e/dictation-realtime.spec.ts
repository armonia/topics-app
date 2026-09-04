/**
 * dictation-realtime.spec.ts - the words appear WHILE you speak, and when the
 * socket dies they still arrive.
 *
 * WHY IT EXISTS. Live dictation is the one feature whose whole value is in the
 * middle of the gesture: a test that only checks the final text would go green
 * on the batch flow it was meant to replace. So what is asserted here is the
 * SEQUENCE - a partial in grey while the microphone is open, a committed
 * segment in the composer, and no `/api/stt` ever paid for.
 *
 * WHAT IS FAKE AND WHAT IS NOT. The microphone is Chromium's fake device fed
 * with a real WAV, so the capture, the AudioContext at 16 kHz, the worklet, the
 * PCM packing and the chunking are the production ones, byte for byte. The
 * ElevenLabs socket is intercepted with `page.routeWebSocket`: the protocol is
 * ours to script (`session_started`, `partial_transcript`,
 * `committed_transcript`), which is the only way a partial can be asserted by
 * its exact text rather than by hope.
 *
 * THE SECOND TEST IS THE ONE THAT MATTERS ON A BAD DAY. Quota spent, key dead,
 * network gone: the socket refuses, and the dictation has to end up in the
 * composer anyway through the batch flow, with the audio that was recorded in
 * parallel the whole time. A live engine that loses what you said when it fails
 * is worse than not having it.
 *
 * @covers STT-06
 */
import { resolve } from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-fixtures";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** Real voice in a real file: the fake device plays it instead of a 440 Hz beep. */
const SPOKEN_WAV = resolve(__dirname, "fixtures/audio/spoken-phrase.wav");

/** What the scripted socket says, in order. Deterministic, so it can be asserted. */
const PARTIAL_TEXT = "git rebase";
const COMMITTED_TEXT = "git rebase --onto main";
/** The segment the stop settles: a second one, so «pasted twice» is visible. */
const FINAL_TEXT = "then run the tests";
/** What the batch flow answers when the socket refuses to open. */
const BATCH_TEXT = "transcribed after the stop";

/** Capabilities that announce a live engine, plus the single-use token the client asks for. */
async function stubRealtimeStt(page: Page, opts: { realtime: boolean }) {
  await page.route("**/api/stt/capabilities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        provider: "elevenlabs",
        model: "scribe_v2",
        providers: [],
        language: null,
        realtime: opts.realtime,
      }),
    }),
  );
  await page.route("**/api/stt/realtime-token", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: "sutkn_e2e",
        model: "scribe_v2_realtime",
        sampleRate: 16000,
        audioFormat: "pcm_16000",
        language: null,
      }),
    }),
  );
}

/** The batch flow, which must stay reachable under the live one. */
async function stubBatchStt(page: Page, seen: { posts: number }) {
  await page.route("**/api/stt", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    seen.posts += 1;
    const body = route.request().postDataBuffer();
    expect(body ? body.length : 0, "the batch POST arrived with no body: the parallel recording lost the audio").toBeGreaterThan(0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ transcript: BATCH_TEXT, provider: "e2e-stub", model: "stub" }),
    });
  });
}

/**
 * A caption burned into the page, only under `E2E_EVIDENCE=1`: the clip of this
 * spec is what the task delivers, and at 268 px a 1280 px UI is a smudge. Zero
 * effect on any other run, and no waiting either: the assertions below already
 * hold the page still where a human needs to read.
 */
async function caption(page: Page, text: string) {
  if (process.env.E2E_EVIDENCE !== "1") return;
  await page.evaluate((t) => {
    const id = "__e2e_caption__";
    const el = document.getElementById(id) ?? document.body.appendChild(Object.assign(document.createElement("div"), { id }));
    el.setAttribute("style",
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
      "background:rgba(10,10,12,.92);color:#fff;font:700 40px/1.25 system-ui,sans-serif;" +
      "padding:12px 18px;border-top:3px solid #8b5cf6;");
    el.textContent = t;
  }, text);
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${SPOKEN_WAV}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
});

test.describe.configure({ timeout: 120_000 });

test.describe.serial("Dictation, live", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `dictation-realtime-${Date.now()}`;
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("a partial appears while speaking, the committed segment lands in the composer", async ({ page, chatPage }) => {
    const batch = { posts: 0 };
    await stubRealtimeStt(page, { realtime: true });
    await stubBatchStt(page, batch);

    // THE SCRIPTED SOCKET. No `connectToServer`, so nothing leaves the machine:
    // the mock IS the service, and it answers the audio the microphone really
    // produced (a chunk only arrives if capture, worklet and PCM packing work).
    await page.routeWebSocket(/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/, (ws) => {
      ws.send(JSON.stringify({ message_type: "session_started", session_id: "e2e", config: { model_id: "scribe_v2_realtime" } }));
      let chunks = 0;
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { message_type?: string; commit?: boolean; audio_base_64?: string };
        if (msg.message_type !== "input_audio_chunk") return;
        expect(msg.audio_base_64, "an audio chunk arrived with no samples").toBeTruthy();
        chunks += 1;
        if (chunks === 1) ws.send(JSON.stringify({ message_type: "partial_transcript", text: PARTIAL_TEXT }));
        // A commit comes either from the VAD, mid-sentence (here: the fourth
        // chunk, about a second of speech), or from the stop. Two DIFFERENT
        // segments, so a segment pasted twice would be visible in the field.
        if (chunks === 4) ws.send(JSON.stringify({ message_type: "committed_transcript", text: COMMITTED_TEXT }));
        if (msg.commit) ws.send(JSON.stringify({ message_type: "committed_transcript", text: FINAL_TEXT }));
      });
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const composer = chatPage.messageInput;
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    await page.keyboard.press("Meta+Shift+D");

    const banner = page.locator('[data-testid="dictation-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    const micOpenAt = Date.now();

    // THE MEASURE: the first partial within a second of the microphone opening.
    // It is the whole point of the feature, so it is asserted and not assumed.
    await caption(page, "Microfono aperto - Scribe v2 in diretta");
    const partial = page.locator('[data-testid="dictation-partial"]');
    await expect(partial).toHaveText(PARTIAL_TEXT, { timeout: 10_000 });
    await caption(page, "Parziale in grigio nella striscia - il campo e' ancora vuoto");
    const firstPartialMs = Date.now() - micOpenAt;
    // The socket is local, so this measures OUR pipeline: capture, 256 ms of
    // buffering, packing, render. The ceiling is generous against a loaded CI
    // machine; the number is printed so a regression is readable, not guessed.
    expect(firstPartialMs, `first partial after ${firstPartialMs} ms`).toBeLessThan(4_000);

    // A partial is a guess: it stays in the strip, it does NOT touch the field.
    expect(await composer.inputValue()).toBe("");

    // The committed segment, on the other hand, is the text: it goes in.
    await expect(composer).toHaveValue(new RegExp(COMMITTED_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 20_000 });
    await caption(page, "Segmento confermato: entra nel composer");

    await page.keyboard.press("Meta+Shift+D");
    await expect(banner).toBeHidden({ timeout: 20_000 });

    // The segment settled by the stop is in the field too, after the first: the
    // last thing said is the part a dictation loses most easily.
    await expect(composer).toHaveValue(new RegExp(`${COMMITTED_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${FINAL_TEXT}`), { timeout: 20_000 });
    await caption(page, "Lo stop conferma l'ultimo segmento: niente coda persa");

    // Committed once, pasted once: the batch flow must not transcribe the same
    // audio again under it, and the batch text must never appear.
    expect(batch.posts, "the live flow committed and batch paid for the same audio again").toBe(0);
    expect(await composer.inputValue()).not.toContain(BATCH_TEXT);
  });

  test("the socket refuses: the audio is not lost, the batch flow transcribes it", async ({ page, chatPage }) => {
    const batch = { posts: 0 };
    await stubRealtimeStt(page, { realtime: true });
    await stubBatchStt(page, batch);

    // Quota spent, key dead, network gone: they all look like this from here.
    await page.routeWebSocket(/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime/, (ws) => {
      ws.close({ code: 1008, reason: "quota_exceeded" });
    });

    await goToApp(page);
    await openTopic(page, topicName);

    const composer = chatPage.messageInput;
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    await page.keyboard.press("Meta+Shift+D");

    const banner = page.locator('[data-testid="dictation-banner"]');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // Long enough to have said something: what matters is that those seconds
    // are in the recorder, not that they are in a socket that never opened.
    await expect(page.locator('[data-testid="dictation-elapsed"]')).toHaveText(/0:0[2-9]/, { timeout: 20_000 });

    await page.keyboard.press("Meta+Shift+D");
    await expect(banner).toBeHidden({ timeout: 30_000 });

    await caption(page, "Socket rifiutato - l'audio registrato passa al flusso batch");
    await expect(composer).toHaveValue(new RegExp(BATCH_TEXT), { timeout: 30_000 });
    await caption(page, "Trascritto comunque: niente audio perso");
    expect(batch.posts, "the refused socket did not hand the audio back to the batch flow").toBe(1);
  });
});
