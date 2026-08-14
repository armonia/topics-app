/**
 * How much OPENING a chat weighs.
 *
 * No gate in this repo watched the bytes that `/api/history` puts on the wire.
 * The frame budget (`check:fluido`) and the click-to-ink one (`check:ink`)
 * measure what happens AFTER the data has arrived: by construction they say
 * nothing about a response that has grown fat by megabytes, that is, precisely
 * about the seconds of empty screen you see on a PWA over the LAN.
 *
 * Two different things are measured here, and the first is the one that counts:
 *
 *  1. INVARIANT: the same text never travels twice on the wire. The result of a
 *     tool sits in `toolCall.result` AND inside `toolCall.detail`
 *     (`detail.output` for a shell, `detail.content` for a Read), and the
 *     renderer reads only the second. It is a structural property: it does not
 *     depend on the machine, it never needs recalibrating, and it goes red as
 *     soon as somebody puts the copy back. Measured on 2026-08-14 on the DB of
 *     this machine, topic 6b99e9cf: 8.20 MB → 5.42 MB, that is 34% of the
 *     payload was duplicated, across 1,015 tool calls.
 *
 *  2. BUDGET: the bytes per message on a fixed fixture. It is there to see the
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
async function historyPayload(sessionKey: string): Promise<{ body: string; json: { messages: StoredMessage[] } }> {
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
  return { body, json: JSON.parse(body) };
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

describe("weight of /api/history", () => {
  test("INVARIANT: no tool text travels twice", async () => {
    const { json } = await historyPayload("topic:weight-inv");
    const calls = wireToolCalls(json.messages);
    expect(calls.length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    expect(duplicated(calls).map((tc) => tc.id)).toEqual([]);
  });

  test("the trimming is LOSSLESS: the text removed is still readable in detail", async () => {
    const { json } = await historyPayload("topic:weight-lossless");
    const calls = wireToolCalls(json.messages);
    // No call lost its text: either `result` is still there, or `detail` carries it.
    for (const tc of calls) {
      const text = detailStrings(tc.detail).find((s) => s.includes("the line of a tool output"));
      expect(typeof text === "string" && text.length > 0).toBe(true);
    }
    // And the rest of the row is intact: id, name, status.
    expect(calls.every((tc) => tc.id && tc.name && tc.status === "success")).toBe(true);
  });

  test("BUDGET: the bytes per message of the fixture stay under the ceiling", async () => {
    const { body, json } = await historyPayload("topic:weight-budget");
    const perMessage = body.length / json.messages.length;
    // Measured on 2026-08-14 on this fixture: ~6.4 KB per message (the 3
    // outputs of 4 KB weigh only on the assistant message, and the two roles
    // alternate). The ceiling is DOUBLE the measured value: under it fits the
    // variation of a JSON.stringify between Bun versions, over it lands anyone
    // who puts a second copy of the text back, which would be exactly +100%.
    expect(perMessage).toBeLessThan(13 * 1024);
    // And the floor: if one day the fixture stopped carrying the outputs, the
    // budget would go green measuring nothing.
    expect(perMessage).toBeGreaterThan(3 * 1024);
  });

  test("the gate KNOWS how to go red: the same payload without the trimming does not pass", async () => {
    const { json } = await historyPayload("topic:weight-red");
    // The payload from before with the copy put back in, that is, exactly what
    // the router returned before `leanToolCall`.
    const fat = json.messages.map((m) => ({
      ...m,
      blocks: (m.blocks ?? []).map((b) => {
        const tc = (b as { toolCall?: ToolCall }).toolCall;
        if (!tc) return b;
        const text = detailStrings(tc.detail).find((s) => s.length > 100);
        return { ...b, toolCall: { ...tc, result: text } };
      }),
    })) as StoredMessage[];
    const calls = wireToolCalls(fat);
    expect(duplicated(calls).length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    // and it weighs double, which is the reason the invariant exists
    expect(JSON.stringify(fat).length).toBeGreaterThan(JSON.stringify(json.messages).length * 1.8);
  });
});
