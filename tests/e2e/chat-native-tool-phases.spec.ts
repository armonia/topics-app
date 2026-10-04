/**
 * What a native-runtime tool row says while the call is NOT running yet.
 *
 * The native runtime announces a call when the model starts writing it and
 * runs the calls of one round one after the other (`agent-loop.ts`). The row
 * used to be "running", spinner and stopwatch, from the announcement on: a call
 * queued behind a long shell looked stuck on a command that had not started
 * (diagnosis of 04/10: 288 native calls queued over 1 s in three days, the
 * worst 1,135.6 s for 0.3 s of real work). And while the model wrote a long
 * command, the shell row stayed `$ ` with nothing after it until the last byte
 * of the input arrived (up to 37 s measured live).
 *
 * The turns here are REAL server turns on the native runtime with a real shell;
 * only the model is fake (`helpers/fake-anthropic-api.ts`).
 *
 * @covers CHAT-NTOOL-05
 * @covers CHAT-NTOOL-06
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic, type FakeRound } from "./helpers/fake-anthropic-api";

/** How long `recordWire({ until: "answered" })` keeps the question's result back. */
const RESULT_HELD_MS = 3_000;

const LONG_COMMAND = `cat > /dev/null <<'EOF'\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\nEOF\necho written`;

const SCRIPTS: Record<string, FakeRound[]> = {
  // Two calls in ONE round: the second waits for the first.
  pair: [{ tools: [
    { name: "bash", input: { command: "sleep 5; echo first" } },
    { name: "bash", input: { command: "echo second" } },
  ] }],
  // A question queued behind a shell in the same round.
  askq: [{ tools: [
    { name: "bash", input: { command: "sleep 2; echo first" } },
    { name: "ask_user_question", input: { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "One" }, { label: "Two" }], multiSelect: false }] } },
  ] }],
  // The model takes 10 s to write one long command.
  slowargs: [{ tools: [{ name: "bash", argStreamMs: 10_000, input: { command: LONG_COMMAND } }] }],
};

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

/** Registers or removes the native runtime on the running bench (`/api/test/native-runtime`). */
async function nativeRuntime(body: { on: boolean; workspace?: string }): Promise<unknown> {
  const res = await fetch(`${E2E_BASE}/api/test/native-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function nativeTopic(request: APIRequestContext, name: string) {
  const topic = await createTopic(request, `${name}-${Date.now()}`);
  await patchTopic(request, topic.id, { provider: "topics" });
  const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
  await resetPaneStore(request, [topic.id]);
  return { topic, sessionKey };
}

async function openChat(page: Page, messageInput: Locator, name: string) {
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(name));
  await messageInput.waitFor({ state: "visible", timeout: 15_000 });
}

type StoredCall = { id: string; status?: string; startedAt?: number; endedAt?: number };

async function storedCalls(request: APIRequestContext, sessionKey: string): Promise<StoredCall[]> {
  const body = await (await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`)).json() as {
    messages: Array<{ role: string; toolCalls?: StoredCall[]; blocks?: Array<{ kind: string; toolCall?: StoredCall }> }>;
  };
  // The wire carries the timeline (`blocks`) and drops the legacy bucket beside it.
  return body.messages.filter((m) => m.role === "assistant").flatMap((m) =>
    m.blocks?.length ? m.blocks.flatMap((b) => (b.kind === "tool" && b.toolCall ? [b.toolCall] : [])) : (m.toolCalls ?? []));
}

/**
 * Records, in the page, every status each tool row shows and when, so a test
 * can read the order afterwards even when one read delivered several steps.
 */
async function recordRowStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: Array<{ id: string; status: string; at: number }> = [];
    (window as unknown as { __rowStatuses: typeof seen }).__rowStatuses = seen;
    const note = (el: Element) => {
      const id = el.getAttribute("data-testid") ?? "";
      if (!id.startsWith("tool-call-row-")) return;
      const status = el.getAttribute("data-status") ?? "";
      const last = [...seen].reverse().find((h) => h.id === id);
      if (last?.status !== status) seen.push({ id, status, at: performance.now() });
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") note(r.target as Element);
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          note(n);
          n.querySelectorAll('[data-testid^="tool-call-row-"]').forEach(note);
        });
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-status"] });
  });
}

async function rowHistory(page: Page): Promise<Array<{ id: string; status: string; at: number }>> {
  return page.evaluate(() => (window as unknown as { __rowStatuses: Array<{ id: string; status: string; at: number }> }).__rowStatuses);
}

/**
 * Records, in the page, what the window was handed and when: every read of its
 * own reply's SSE (`/api/chat`) and every WS frame about a tool, on the same
 * clock as `recordRowStatuses`. Installed before the app loads, so the socket
 * the app opens is the one tapped.
 *
 * `holdLikeWebKit` replays, every time, the order measured in the runs that
 * failed (04/10, 1 run in 20): the SSE reads that announce the rows are held
 * until the question has come over WS, and the SSE copy of the question, the
 * last byte before the turn pauses, never comes. Held, not dropped: the stream
 * is not read meanwhile, as when WebKit keeps a burst back.
 *
 * `until: "answered"` holds the same reads longer, until the answer given in
 * another window has come over WS too, and then keeps the question's own
 * result back for `RESULT_HELD_MS`: the window between the row's birth and its
 * result, which is where a row born on a panel already closed shows.
 */
async function recordWire(page: Page, opts: { holdLikeWebKit?: boolean; until?: "asked" | "answered" } = {}): Promise<void> {
  await page.addInitScript(({ holdLikeWebKit, until, resultHeldMs }) => {
    type Entry = { via: "sse" | "ws"; at: number; what: string[] };
    const wire: Entry[] = [];
    (window as unknown as { __wire: Entry[] }).__wire = wire;
    let asked = false;
    let questionId = "";
    let release = () => {};
    const askedOverWs = new Promise<void>((resolve) => { release = resolve; });
    const isResultOf = (line: string, id: string): boolean => {
      if (!id || !line.startsWith("data: ")) return false;
      try { return JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_result?.id === id; } catch { return false; }
    };
    const isSseQuestion = (line: string): boolean => {
      try {
        const calls = JSON.parse(line.slice(6)).choices?.[0]?.delta?.tool_calls as Array<{ status?: string }> | undefined;
        return !!calls?.length && calls.every((c) => c.status === "waiting_for_input");
      } catch { return false; }
    };
    const summarize = (obj: Record<string, unknown>): string | null => {
      const delta = (obj.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta;
      if (delta) {
        const out: string[] = [];
        for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
          out.push(`call ${String(tc.id).slice(-6)} ${String(tc.status)}${tc.userInputSchema ? "+form" : ""}`);
        }
        const tr = delta.tool_result as Record<string, unknown> | undefined;
        if (tr) out.push(`result ${String(tr.id).slice(-6)} ${String(tr.status)}`);
        return out.length ? out.join(", ") : null;
      }
      const type = String(obj.type ?? "");
      if (!type.startsWith("stream:tool")) return null;
      const tc = obj.toolCall as Record<string, unknown> | undefined;
      const id = String(obj.toolCallId ?? tc?.id ?? "").slice(-6);
      return `${type} ${id} ${String(obj.status ?? tc?.status ?? "")}`;
    };
    const realFetch = window.fetch.bind(window);
    const recordingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/\/api\/chat(\?|$)/.test(url) || !res.body) return res;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          let text = decoder.decode(value, { stream: true });
          let bytes = value;
          if (holdLikeWebKit) {
            if (!asked && text.includes('"tool_calls"')) await askedOverWs;
            const kept = text.split("\n").filter((line) => !(line.startsWith("data: ") && isSseQuestion(line))).join("\n");
            if (kept !== text) { text = kept; bytes = new TextEncoder().encode(kept); }
          }
          if (holdLikeWebKit && until === "answered" && questionId) {
            const lines = text.split("\n");
            const at = lines.findIndex((line) => isResultOf(line, questionId));
            if (at >= 0) {
              if (at > 0) {
                controller.enqueue(new TextEncoder().encode(`${lines.slice(0, at).join("\n")}\n`));
                wire.push({ via: "sse", at: performance.now(), what: ["(before the held result)"] });
              }
              await new Promise((resolve) => setTimeout(resolve, resultHeldMs));
              text = lines.slice(at).join("\n");
              bytes = new TextEncoder().encode(text);
            }
          }
          const what: string[] = [];
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
            try { const s = summarize(JSON.parse(line.slice(6))); if (s) what.push(s); } catch { what.push("(split frame)"); }
          }
          wire.push({ via: "sse", at: performance.now(), what: what.length ? what : [`${bytes.byteLength} B`] });
          controller.enqueue(bytes);
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
    window.fetch = recordingFetch as typeof window.fetch;
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (ev) => {
          if (typeof ev.data !== "string") return;
          try {
            const frame = JSON.parse(ev.data) as Record<string, unknown>;
            const s = summarize(frame);
            if (s) wire.push({ via: "ws", at: performance.now(), what: [s] });
            // Released in a task of its own: resolving here would let the held
            // read reach the app in this listener's microtask checkpoint,
            // before the app's own `onmessage` has seen the question.
            if (frame.type === "stream:tool_user_input_required") {
              questionId = String(frame.toolCallId ?? "");
              if (until !== "answered") { asked = true; setTimeout(release, 0); }
            }
            if (until === "answered" && frame.type === "stream:tool_update" && frame.userResponse && frame.toolCallId === questionId) {
              asked = true;
              setTimeout(release, 0);
            }
          } catch { /* not JSON */ }
        });
      }
    };
  }, { holdLikeWebKit: opts.holdLikeWebKit ?? false, until: opts.until ?? "asked", resultHeldMs: RESULT_HELD_MS });
}

/** The row statuses and the wire, merged in time order, one line each. */
async function timeline(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __wire?: Array<{ via: string; at: number; what: string[] }>;
      __rowStatuses?: Array<{ id: string; status: string; at: number }>;
    };
    const lines = [
      ...(w.__wire ?? []).map((e) => ({ at: e.at, text: `${e.via.padEnd(3)} ${e.what.join(" | ")}` })),
      ...(w.__rowStatuses ?? []).map((r) => ({ at: r.at, text: `ROW ${r.id.slice(-6)} -> ${r.status}` })),
    ].sort((a, b) => a.at - b.at);
    const t0 = lines[0]?.at ?? 0;
    return lines.map((l) => `${String(Math.round(l.at - t0)).padStart(6)} ms  ${l.text}`).join("\n");
  });
}

hermetic(test);

test.describe("native runtime: a call that has not started is not shown running", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    fake = await startFakeAnthropic(SCRIPTS);
    undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
    workspace = mkdtempSync(join(tmpdir(), "ntool-phases-"));
    expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });
  });
  test.afterAll(async () => {
    await nativeRuntime({ on: false }).catch(() => {});
    undoFake?.();
    await fake?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("the second call of a round says it is queued until the first one ends", async ({ page, request, chatPage, context }) => {
    const { topic, sessionKey } = await nativeTopic(request, "ntool-pair");
    // Read in a second window, which gets the turn over the WebSocket. The
    // sender's own SSE carries the same fields, but in this WebKit the fetch
    // stream sometimes holds a burst back until the next byte, five seconds
    // later here (measured on 2026-10-04: 387 B delivered, 1,066 B held, while
    // a plain Bun client got the 1,453 B burst in one read every time).
    const viewer = await context.newPage();
    await openChat(viewer, viewer.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }), topic.name);
    await openChat(page, chatPage.messageInput, topic.name);
    await recordRowStatuses(page);
    await chatPage.sendMessage("SCEN:pair go");

    const rows = viewer.locator('[data-testid^="tool-call-row-"]');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    const first = rows.nth(0);
    const second = rows.nth(1);
    await expect(first).toHaveAttribute("data-status", "running", { timeout: 10_000 });

    // While the first shell sleeps, the second one is queued: no spinner, no stopwatch.
    await expect(second).toHaveAttribute("data-status", "pending");
    await expect(second.getByTestId("tool-queued")).toHaveAttribute("data-phase", "queued");
    await expect(second.getByTestId("tool-elapsed")).toHaveCount(0);
    await expect(first.getByTestId("tool-elapsed")).toBeVisible();
    // Three seconds into the first shell's sleep, nothing has changed for the second.
    await expect(first.getByTestId("tool-elapsed")).toHaveText(/^[34]\.\ds$/, { timeout: 5_000 });
    await expect(first).toHaveAttribute("data-status", "running");
    await expect(second).toHaveAttribute("data-status", "pending");
    await expect(second.getByTestId("tool-elapsed")).toHaveCount(0);

    // The turn ends (its rows fold behind the answer), and the stored record
    // says the second call started only once the first had ended: its stored
    // duration is its own run, not its wait.

    await expect(viewer.getByText("FINE-pair").first()).toBeVisible({ timeout: 30_000 });
    // The window the message was sent from reads the same rows off its own
    // SSE, which WebKit may hand over in one late burst: there the second
    // call is never shown running before the first one has ended.
    await expect(page.getByText("FINE-pair").first()).toBeVisible({ timeout: 30_000 });
    const seen = await rowHistory(page);
    const [firstId, secondId] = [...new Set(seen.map((h) => h.id))];
    const firstEnded = seen.find((h) => h.id === firstId && h.status === "success")?.at;
    const secondStarted = seen.find((h) => h.id === secondId && h.status !== "pending")?.at;
    expect(firstEnded, JSON.stringify(seen)).toBeDefined();
    expect(secondStarted, JSON.stringify(seen)).toBeDefined();
    expect(secondStarted!, JSON.stringify(seen)).toBeGreaterThanOrEqual(firstEnded!);
    const calls = await storedCalls(request, sessionKey);
    expect(calls).toHaveLength(2);
    const [a, b] = calls as [StoredCall, StoredCall];
    expect([a.status, b.status]).toEqual(["success", "success"]);
    expect(typeof a.endedAt).toBe("number");
    expect(typeof b.startedAt).toBe("number");
    expect(b.startedAt!).toBeGreaterThanOrEqual(a.endedAt!);
    expect(b.endedAt! - b.startedAt!).toBeLessThan(3_000);
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a question queued behind a shell keeps its form in the window it was sent from", async ({ page, request, chatPage, context }) => {
    const { topic, sessionKey } = await nativeTopic(request, "ntool-askq");
    const viewer = await context.newPage();
    await openChat(viewer, viewer.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }), topic.name);
    await recordWire(page);
    await openChat(page, chatPage.messageInput, topic.name);
    await recordRowStatuses(page);
    await chatPage.sendMessage("SCEN:askq go");

    // When the shell ends, the question starts and asks at once. Its `running`
    // announcement leaves on the sender's SSE, its form on WS: a later
    // announcement must not take the form away (reported 04/10, 4 runs out of 4).
    await expect.poll(async () => (await storedCalls(request, sessionKey)).map((c) => c.status), { timeout: 20_000 })
      .toEqual(["success", "waiting_for_input"]);
    const viewerQuestion = viewer.locator('[data-testid^="tool-call-row-"]').nth(1);
    await expect(viewerQuestion).toHaveAttribute("data-status", "waiting_for_input", { timeout: 10_000 });

    const question = page.locator('[data-testid^="tool-call-row-"]').nth(1);
    await expect(question).toHaveAttribute("data-status", "waiting_for_input", { timeout: 10_000 })
      .catch(async (err: Error) => { throw new Error(`${err.message}\n\nsender timeline:\n${await timeline(page)}`); });
    // It has to HOLD, not just pass by: the announcement lands after the form.
    const heldFrom = Date.now();
    await expect.poll(async () => {
      const status = await question.getAttribute("data-status");
      if (status !== "waiting_for_input") return `went back to ${status}`;
      return Date.now() - heldFrom >= 3_000 ? "held" : "holding";
    }, { timeout: 8_000, intervals: [200] }).toBe("held");
    const form = question.locator('[data-testid^="tool-input-form-"]');
    await expect(form).toBeVisible();
    await expect(question.getByTestId("tool-elapsed")).toHaveCount(0);
    await expect(chatPage.messageInput).toHaveAttribute("placeholder", /Rispondi alla domanda|Answer the question/);

    // And it can be answered from there: the turn goes on to its end.
    await form.locator('input[type="radio"][value="One"]').check();
    await form.getByTestId("ask-submit").click();
    await expect(page.getByText("FINE-askq").first()).toBeVisible({ timeout: 30_000 });
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a question whose row reaches the sender after its form still opens the form there", async ({ page, request, chatPage }) => {
    // The order of the runs that failed, every time: the WS question comes
    // first and finds no row, the held SSE burst then gives birth to the row
    // as queued and running, and the SSE copy of the question never comes.
    const { topic, sessionKey } = await nativeTopic(request, "ntool-askq-held");
    await recordWire(page, { holdLikeWebKit: true });
    await openChat(page, chatPage.messageInput, topic.name);
    await recordRowStatuses(page);
    await chatPage.sendMessage("SCEN:askq go");

    await expect.poll(async () => (await storedCalls(request, sessionKey)).map((c) => c.status), { timeout: 20_000 })
      .toEqual(["success", "waiting_for_input"]);
    const question = page.locator('[data-testid^="tool-call-row-"]').nth(1);
    await expect(question).toHaveAttribute("data-status", "waiting_for_input", { timeout: 10_000 })
      .catch(async (err: Error) => { throw new Error(`${err.message}\n\nsender timeline:\n${await timeline(page)}`); });
    // The replay did what it says: the row was born after the WS question, and no SSE question came.
    const wire = await page.evaluate(() => (window as unknown as { __wire: Array<{ via: string; at: number; what: string[] }> }).__wire);
    const askedAt = wire.find((e) => e.via === "ws" && e.what.some((w) => w.startsWith("stream:tool_user_input_required")))?.at;
    const rows = await rowHistory(page);
    const questionId = (await question.getAttribute("data-testid"))!;
    const bornAt = rows.find((r) => r.id === questionId)?.at;
    expect(askedAt, await timeline(page)).toBeDefined();
    expect(bornAt!, await timeline(page)).toBeGreaterThan(askedAt!);
    expect(wire.some((e) => e.via === "sse" && e.what.some((w) => w.includes("+form"))), await timeline(page)).toBe(false);

    const form = question.locator('[data-testid^="tool-input-form-"]');
    await expect(form).toBeVisible();
    await expect(question.getByTestId("tool-elapsed")).toHaveCount(0);
    await expect(chatPage.messageInput).toHaveAttribute("placeholder", /Rispondi alla domanda|Answer the question/);
    await form.locator('input[type="radio"][value="One"]').check();
    await form.getByTestId("ask-submit").click();
    await expect(page.getByText("FINE-askq").first()).toBeVisible({ timeout: 30_000 });
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a question answered in another window before its row reaches the sender is not asked again there", async ({ page, request, chatPage, context }) => {
    // The same held burst, but the person answers on the other window (the
    // phone shows the form at once over WS) before the sender's row is born.
    // The answer frame used to be dropped while the question was held, so the
    // row was born on the form and kept it until the result: a form over a
    // question already answered.
    const { topic, sessionKey } = await nativeTopic(request, "ntool-askq-answered");
    const viewer = await context.newPage();
    await openChat(viewer, viewer.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }), topic.name);
    await recordWire(page, { holdLikeWebKit: true, until: "answered" });
    await openChat(page, chatPage.messageInput, topic.name);
    await recordRowStatuses(page);
    await chatPage.sendMessage("SCEN:askq go");

    const viewerQuestion = viewer.locator('[data-testid^="tool-call-row-"]').nth(1);
    await expect(viewerQuestion).toHaveAttribute("data-status", "waiting_for_input", { timeout: 20_000 });
    // Nothing reached the sender's rows yet: its SSE is held.
    await expect(page.locator('[data-testid^="tool-call-row-"]')).toHaveCount(0);
    const viewerForm = viewerQuestion.locator('[data-testid^="tool-input-form-"]');
    await viewerForm.locator('input[type="radio"][value="One"]').check();
    await viewerForm.getByTestId("ask-submit").click();

    // Born after the answer, while its result is still held: running, no form.
    const question = page.locator('[data-testid^="tool-call-row-"]').nth(1);
    await expect(question).toHaveAttribute("data-status", "running", { timeout: RESULT_HELD_MS })
      .catch(async (err: Error) => { throw new Error(`${err.message}\n\nsender timeline:\n${await timeline(page)}`); });
    await expect(question.locator('[data-testid^="tool-input-form-"]')).toHaveCount(0);

    await expect(page.getByText("FINE-askq").first()).toBeVisible({ timeout: 30_000 });
    // The text can come before the held result: the row closes when the result does.
    await expect(question).toHaveAttribute("data-status", "success", { timeout: 10_000 });
    const questionId = (await question.getAttribute("data-testid"))!;
    const statuses = (await rowHistory(page)).filter((r) => r.id === questionId).map((r) => r.status);
    expect(statuses, await timeline(page)).not.toContain("waiting_for_input");
    expect(statuses.at(-1), await timeline(page)).toBe("success");
    // The replay did what it says: the answer came over WS before the row was born.
    const wire = await page.evaluate(() => (window as unknown as { __wire: Array<{ via: string; at: number; what: string[] }> }).__wire);
    const answeredAt = wire.find((e) => e.via === "ws" && e.what.some((w) => w.startsWith("stream:tool_update") && w.endsWith("running")))?.at;
    const bornAt = (await rowHistory(page)).find((r) => r.id === questionId)?.at;
    expect(answeredAt, await timeline(page)).toBeDefined();
    expect(bornAt!, await timeline(page)).toBeGreaterThan(answeredAt!);
    expect((await storedCalls(request, sessionKey)).map((c) => c.status)).toEqual(["success", "success"]);
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a long command shows on its row while the model is still writing it", async ({ page, request, chatPage }) => {
    const { topic } = await nativeTopic(request, "ntool-slowargs");
    await openChat(page, chatPage.messageInput, topic.name);
    await chatPage.sendMessage("SCEN:slowargs go");

    const row = page.locator('[data-testid^="tool-call-row-"]').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    // The input takes 10 s to arrive; the command has to be on the row well before.
    await expect(row).toContainText("cat > /dev/null", { timeout: 4_000 });
    await expect(row).toHaveAttribute("data-status", "pending");
    await expect(row.getByTestId("tool-queued")).toHaveAttribute("data-phase", "writing");
    const inputDone = [...fake!.inputDoneAt.keys()].filter((k) => k.startsWith("slowargs:"));
    expect(inputDone, "the input was still streaming when the command showed").toEqual([]);

    await expect(page.getByText("FINE-slowargs").first()).toBeVisible({ timeout: 30_000 });
    await deleteTopic(request, topic.id).catch(() => {});
  });
});
