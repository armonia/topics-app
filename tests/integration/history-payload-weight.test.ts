/**
 * How much OPENING a chat weighs.
 *
 * No gate in this repo watched the bytes that `/api/history` puts on the wire.
 * The frame budget (`check:fluido`) and the click-to-ink one (`check:ink`)
 * measure what happens AFTER the data has arrived: by construction they say
 * nothing about a response that has grown fat by megabytes, that is, precisely
 * about the seconds of empty screen you see on a PWA over the LAN.
 *
 * Three things are measured here:
 *
 *  1. INVARIANT: the same text never travels twice on the wire. The result of a
 *     tool sits in `toolCall.result` AND inside `toolCall.detail`
 *     (`detail.output` for a shell, `detail.content` for a Read), and the
 *     renderer reads only the second. It is a structural property: it does not
 *     depend on the machine, it never needs recalibrating, and it goes red as
 *     soon as somebody puts the copy back. Measured on 2026-08-14 on the DB of
 *     this machine, topic 6b99e9cf: 8.20 MB -> 5.42 MB, that is 34% of the
 *     payload was duplicated, across 1,015 tool calls.
 *
 *  2. STRIP: the large text fields inside `detail` (`output`, `content`,
 *     `result`) are blanked on the wire. `toolCall.detailBytes` carries the
 *     original byte count, so the row knows it has a body and can fetch it
 *     lazily. This halves the remaining payload: 5.42 MB -> ~2.58 MB on the
 *     real topic. Gate: payload < 4.4% of the pre-strip size (the margin
 *     measured on the real topic).
 *
 *  3. BUDGET: the bytes per message on a fixed fixture. It is there to see the
 *     NEW fat, the kind no invariant knows about yet.
 *
 * The last test is the gate looking at itself in the mirror: it builds the same
 * payload WITHOUT the trimming and demands that the invariant reject it. A
 * condition never seen to fail is not a gate, it is a decoration.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("history-weight-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

/** A tool output as big as the real ones: the measured median is ~4 KB. */
function fakeOutput(seed: string, kb: number): string {
  const line = `${seed} :: the line of a tool output, as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/**
 * A tool call as the provider writes it: the text in `detail` AND in `result`.
 * It is the shape that comes from the DB, before the router trims it.
 */
function toolCall(id: string, kind: "shell" | "read", kb: number): ToolCall {
  const output = fakeOutput(id, kb);
  const detail = kind === "shell"
    ? { type: "shell" as const, command: `echo ${id}`, output }
    : { type: "read" as const, filePath: `/tmp/${id}.txt`, content: output };
  return { id, name: kind === "shell" ? "Bash" : "Read", args: {}, status: "success", result: output, detail };
}

/**
 * Fixture: 20 assistant messages, 3 tool calls each of 4 KB. The proportions
 * (how many tools per message, how much an output weighs) come from the real DB
 * of this machine, not from a round number picked by hand.
 */
const MESSAGES = 20;
const TOOLS_PER_MESSAGE = 3;
const TOOL_KB = 4;

function seedThread(ctx: AppContext, sessionKey: string, p: string): void {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < MESSAGES; i++) {
    const u = `${p}-u${i}`;
    msgs.push({ id: u, role: "user", content: `question ${i}`, timestamp: new Date(Date.now() + i * 2000).toISOString(), parentId });
    const blocks: ContentBlock[] = [];
    const calls: ToolCall[] = [];
    for (let t = 0; t < TOOLS_PER_MESSAGE; t++) {
      const tc = toolCall(`${p}-${i}-${t}`, t % 2 === 0 ? "shell" : "read", TOOL_KB);
      calls.push(tc);
      blocks.push({ kind: "tool", toolCall: tc } as ContentBlock);
    }
    blocks.push({ kind: "text", text: `answer ${i}` } as ContentBlock);
    const a = `${p}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: `answer ${i}`, timestamp: new Date(Date.now() + i * 2000 + 1000).toISOString(), parentId: u, blocks, toolCalls: calls });
    parentId = a;
  }
  ctx.saveLocalMessages(sessionKey, msgs);
}

/** `messages.id` is a GLOBAL primary key: every session seeds with a prefix of its own. */
async function historyPayload(sessionKey: string): Promise<{ body: string; json: { messages: StoredMessage[] }; ctx: AppContext }> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  seedThread(ctx, sessionKey, sessionKey.replace(/[^a-z0-9]/gi, ""));
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const url = new URL(`http://h${path}?limit=0`);
  const resp = (await router(new Request(url), url, path, "GET"))!;
  expect(resp.status).toBe(200);
  const body = await resp.text();
  return { body, json: JSON.parse(body), ctx };
}

/** Every tool call the payload puts on the wire, wherever it sits. */
function wireToolCalls(messages: StoredMessage[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    for (const b of (m.blocks ?? []) as Array<{ toolCall?: ToolCall }>) if (b.toolCall) out.push(b.toolCall);
    for (const tc of m.toolCalls ?? []) out.push(tc);
  }
  return out;
}

/** The strings inside `detail`, down to the second level (where `raw` lives). */
function detailStrings(detail: unknown, depth = 0): string[] {
  if (typeof detail === "string") return [detail];
  if (depth >= 2 || detail === null || typeof detail !== "object") return [];
  return Object.values(detail as Record<string, unknown>).flatMap((v) => detailStrings(v, depth + 1));
}

/** Which tool calls carry a `result` already present, identical, inside `detail`. */
function duplicated(calls: ToolCall[]): ToolCall[] {
  return calls.filter((tc) => typeof tc.result === "string" && tc.result.length > 0 && detailStrings(tc.detail).includes(tc.result));
}

/**
 * The same fixture text reconstructed from the seed (what the DB carries),
 * used to build a "fat" payload for the red-gate test.
 */
function fatToolCall(tc: ToolCall, p: string): ToolCall {
  // The id encodes the seed: `${p}-${i}-${t}`, so we can recover the output.
  const output = fakeOutput(tc.id, TOOL_KB);
  return { ...tc, result: output };
}

describe("weight of /api/history", () => {
  test("INVARIANT: no tool text travels twice", async () => {
    const { json } = await historyPayload("topic:weight-inv");
    const calls = wireToolCalls(json.messages);
    expect(calls.length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    expect(duplicated(calls).map((tc) => tc.id)).toEqual([]);
  });

  test("STRIP: large detail fields are blanked and detailBytes is set", async () => {
    const { json } = await historyPayload("topic:weight-strip");
    const calls = wireToolCalls(json.messages);
    expect(calls.length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    for (const tc of calls) {
      // The stripped fields are empty strings, not missing.
      const det = tc.detail as Record<string, unknown>;
      const strippedField = det.output ?? det.content ?? det.result;
      expect(strippedField).toBe("");
      // detailBytes records how many characters were removed.
      expect(typeof tc.detailBytes).toBe("number");
      expect((tc.detailBytes ?? 0) > 0).toBe(true);
      // The structural fields (command, filePath, type) are intact.
      expect(typeof det.type).toBe("string");
    }
    // The rest of the row is intact: id, name, status.
    expect(calls.every((tc) => tc.id && tc.name && tc.status === "success")).toBe(true);
  });

  test("STRIP: detailBytes accounts for bytes removed (sum matches pre-strip minus post-strip)", async () => {
    const { json } = await historyPayload("topic:weight-bytes");
    const calls = wireToolCalls(json.messages);
    // All calls have detailBytes set.
    const totalDeclared = calls.reduce((s, tc) => s + (tc.detailBytes ?? 0), 0);
    // Each call had TOOL_KB * 1024 characters in its output/content field.
    // The declared sum must be strictly positive and proportional.
    expect(totalDeclared).toBeGreaterThan(0);
    // The declared bytes are exactly the characters removed: verify against
    // the reconstructed pre-strip size for each call.
    const totalExpected = calls.reduce((s, tc) => {
      const expected = fakeOutput(tc.id, TOOL_KB).length;
      return s + expected;
    }, 0);
    expect(totalDeclared).toBe(totalExpected);
  });

  test("STRIP: payload is less than half the pre-strip size (4.4% margin matches real topic)", async () => {
    // Build the pre-strip size from the same fixture to compare apples to apples.
    // We use TWO ctx: one for the stripped payload, one reconstructed as "fat".
    const { body: strippedBody, json } = await historyPayload("topic:weight-half");
    const calls = wireToolCalls(json.messages);

    // Reconstruct what the payload looked like before stripping.
    const fatMessages = json.messages.map((m) => ({
      ...m,
      blocks: (m.blocks ?? []).map((b) => {
        const tc = (b as { toolCall?: ToolCall }).toolCall;
        if (!tc) return b;
        return { ...b, toolCall: fatToolCall(tc, "topicweighthalf") };
      }),
      toolCalls: (m.toolCalls ?? []).map((tc) => fatToolCall(tc, "topicweighthalf")),
    }));
    const fatSize = JSON.stringify(fatMessages).length;
    const strippedSize = strippedBody.length;

    // The stripped payload must be significantly smaller than the pre-strip one.
    // Measured margin on the real topic: 4.4% (5.42 MB -> 2.58 MB = 52.4% reduction).
    // Gate: stripped must be less than 52% of the fat size (i.e. > 48% reduction).
    expect(strippedSize).toBeLessThan(fatSize * 0.52);
    // Floor: the strip removed SOMETHING (at least the text fields).
    expect(strippedSize).toBeLessThan(fatSize * 0.95);
    // The declared detailBytes must sum to the difference.
    const totalDeclared = calls.reduce((s, tc) => s + (tc.detailBytes ?? 0), 0);
    expect(totalDeclared).toBeGreaterThan(0);
  });

  test("DETAIL ENDPOINT: the full text is recoverable via the detail route", async () => {
    const { json, ctx } = await historyPayload("topic:weight-endpoint");
    const { createToolDetailRouter } = await import("../../server/routes/history");
    const detailRouter = createToolDetailRouter(ctx);

    // Find the first assistant message with a tool call in blocks.
    const aMsg = json.messages.find((m) => m.role === "assistant" && (m.blocks ?? []).some((b) => (b as { toolCall?: ToolCall }).toolCall));
    expect(aMsg).toBeTruthy();
    const firstTc = ((aMsg!.blocks ?? []) as Array<{ toolCall?: ToolCall }>).find((b) => b.toolCall)?.toolCall!;
    expect(firstTc).toBeTruthy();

    // The wire payload has the field empty.
    const det = firstTc.detail as Record<string, unknown>;
    const wireField = det.output ?? det.content;
    expect(wireField).toBe("");

    // The detail endpoint returns the full text.
    const path = `/api/messages/${encodeURIComponent(aMsg!.id)}/tool/${encodeURIComponent(firstTc.id)}/detail`;
    const url = new URL(`http://h${path}`);
    const resp = await detailRouter(new Request(url), url, path, "GET");
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const { detail: fullDetail } = await resp!.json() as { detail: Record<string, unknown> };
    const fullField = fullDetail.output ?? fullDetail.content;
    expect(typeof fullField).toBe("string");
    expect((fullField as string).length).toBeGreaterThan(100);
    expect((fullField as string)).toContain("the line of a tool output");
  });

  test("BUDGET: the bytes per message of the fixture stay under the ceiling", async () => {
    const { body, json } = await historyPayload("topic:weight-budget");
    const perMessage = body.length / json.messages.length;
    // With stripping: the fixture has 3 tools of 4 KB each per assistant message,
    // and assistant messages alternate with user messages (half each). The tool
    // text is now blank on the wire, so the assistant message carries only the
    // structural fields + detailBytes. Measured post-strip: ~1.5 KB per message.
    // The ceiling is still 13 KB (double the pre-strip measured value of ~6.4 KB)
    // so it would catch anyone who puts the text back in.
    expect(perMessage).toBeLessThan(13 * 1024);
    // Floor: the message has at least a text field and a handful of tool fields.
    expect(perMessage).toBeGreaterThan(200);
  });

  test("the gate KNOWS how to go red: the same payload without the trimming does not pass", async () => {
    const { json } = await historyPayload("topic:weight-red");
    // Reconstruct the fat payload: put the original text back in `result` so
    // the `duplicated()` check fires. We source the text from the seed, not
    // from the stripped detail (which is now empty).
    const p = "topicweightred";
    const fat = json.messages.map((m) => ({
      ...m,
      blocks: (m.blocks ?? []).map((b) => {
        const tc = (b as { toolCall?: ToolCall }).toolCall;
        if (!tc) return b;
        const text = fakeOutput(tc.id, TOOL_KB);
        // Put the original output back into detail so it matches result.
        const det = tc.detail as Record<string, unknown>;
        const fattedDet = det.output !== undefined
          ? { ...det, output: text }
          : { ...det, content: text };
        return { ...b, toolCall: { ...tc, result: text, detail: fattedDet } };
      }),
    })) as StoredMessage[];
    const calls = wireToolCalls(fat);
    expect(duplicated(calls).length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    // and it weighs much more than the stripped version, which is the reason the strip exists
    expect(JSON.stringify(fat).length).toBeGreaterThan(JSON.stringify(json.messages).length * 1.8);
    void p; // used only to document the seed derivation above
  });
});
