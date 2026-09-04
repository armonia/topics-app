/**
 * What `{"limit":1}` COSTS on a fat session.
 *
 * `/api/history` used to hydrate the whole thread before applying the limit:
 * `SELECT *` on every row of the session, then a `JSON.parse` of `blocks` and
 * of `tool_calls` for each one, and only at the end a `slice(-limit)`. On the
 * heaviest topic of this machine (49 messages, 7.0 MB of blocks plus 7.2 MB of
 * tool calls) that meant reading and parsing 14.2 MB to answer 5 KB - with
 * bun:sqlite being synchronous and Bun having one event loop, streaming, WS,
 * PTY and the browser pane all stop for the duration.
 *
 * The gate is a RATIO, not a stopwatch: the same request against a session ten
 * times fatter must not cost ten times more, because the answer is the same
 * size. Both sides are measured in the same run, on the same machine, in the
 * same interleaved loop, so a loaded CI moves them together.
 *
 * The last test is the gate looking at itself: it asks for the WHOLE thread
 * (`limit:0`, what the chat pane sends) and demands the fat session be visibly
 * more expensive - if that one did not grow, the fixture would not be fat and
 * the ratio above would prove nothing.
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("history-limit-cost-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

/** Roughly half a megabyte of tool output, the shape a real agentic turn has. */
function blob(seed: string, kb: number): string {
  const line = `${seed} :: one line of a tool output, about as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

const TURN_KB = 500;

/** N assistant turns, each carrying ~TURN_KB in `blocks` AND in `tool_calls`. */
function seedThread(ctx: AppContext, sessionKey: string, prefix: string, turns: number): void {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < turns; i++) {
    const u = `${prefix}-u${i}`;
    msgs.push({ id: u, role: "user", content: `question ${i}`, timestamp: new Date(Date.now() + i * 2000).toISOString(), parentId });
    const output = blob(`${prefix}-${i}`, TURN_KB);
    const tc: ToolCall = { id: `${prefix}-t${i}`, name: "Bash", args: {}, status: "success", detail: { type: "shell", command: `echo ${i}`, output } };
    const blocks: ContentBlock[] = [
      { kind: "tool", toolCall: tc } as ContentBlock,
      { kind: "text", text: `answer ${i}` } as ContentBlock,
    ];
    const a = `${prefix}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: `answer ${i}`, timestamp: new Date(Date.now() + i * 2000 + 1000).toISOString(), parentId: u, blocks, toolCalls: [tc] });
    parentId = a;
  }
  ctx.saveLocalMessages(sessionKey, msgs);
}

type Caller = (limit: number) => Promise<{ status: number; messages: StoredMessage[]; total: number; bytes: number }>;

async function historyCaller(sessionKey: string, turns: number): Promise<Caller> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  seedThread(ctx, sessionKey, sessionKey.replace(/[^a-z0-9]/gi, ""), turns);
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  return async (limit: number) => {
    const url = new URL(`http://h${path}?limit=${limit}`);
    const resp = (await router(new Request(url), url, path, "GET"))!;
    const body = await resp.text();
    const parsed = JSON.parse(body);
    return { status: resp.status, messages: parsed.messages, total: parsed.total, bytes: body.length };
  };
}

/** Median wall clock of `runs` calls, interleaving the two sessions. */
async function medianPair(a: Caller, b: Caller, limit: number, runs = 5): Promise<[number, number]> {
  const ta: number[] = [];
  const tb: number[] = [];
  for (let i = 0; i < runs; i++) {
    let t0 = performance.now(); await a(limit); ta.push(performance.now() - t0);
    t0 = performance.now(); await b(limit); tb.push(performance.now() - t0);
  }
  const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  return [median(ta), median(tb)];
}

describe("cost of a limited /api/history", () => {
  test("a one-message answer does not pay for the whole session", async () => {
    // ~1 MB against ~14 MB across `blocks` + `tool_calls`.
    const small = await historyCaller("topic:cost-small", 1);
    const big = await historyCaller("topic:cost-big", 14);

    const first = await big(1);
    expect(first.status).toBe(200);
    expect(first.messages.length).toBe(1);
    expect(first.total).toBe(28);

    const [tSmall, tBig] = await medianPair(small, big, 1);
    // Before the fix this ratio was ~14x: the limit was applied after
    // hydrating everything. The bar is deliberately loose (a shared machine
    // moves both numbers) - what it rejects is growth PROPORTIONAL to the
    // session, not the millisecond.
    const ratio = tBig / Math.max(tSmall, 0.05);
    expect(ratio).toBeLessThan(4);
  });

  test("the fixture really is fat: asking for everything does cost more", async () => {
    const small = await historyCaller("topic:cost-small-all", 1);
    const big = await historyCaller("topic:cost-big-all", 14);
    const [tSmall, tBig] = await medianPair(small, big, 0, 3);
    expect(tBig / Math.max(tSmall, 0.05)).toBeGreaterThan(3);
  });

  test("the limited answer carries the same message the full one ends with", async () => {
    const big = await historyCaller("topic:cost-identity", 4);
    const one = (await big(1)).messages[0];
    const all = (await big(0)).messages;
    expect(one.id).toBe(all[all.length - 1].id);
    // And it is hydrated: the returned row keeps its timeline, tool block
    // included (`toolCalls` is the copy `leanMessagesForWire` drops when the
    // blocks already carry it - see history-payload-weight.test.ts).
    const blocks = one.blocks ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => (b as { kind?: string }).kind === "tool")).toBe(true);
  });
});
