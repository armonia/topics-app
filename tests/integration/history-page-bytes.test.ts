/**
 * The FIRST page of `/api/history` has a budget in BYTES, not only in messages.
 *
 * `HISTORY_FIRST_PAGE = 40` bounds the COUNT, and the comment next to it used
 * to promise "a few tens of KB of lean rows". Measured in read-only on this
 * machine's own state on 2026-09-07, forty messages of an agentic topic weigh
 * 0.66 to 1.33 MB AFTER the lean stripping - 30x to 60x the promise. That page
 * is what the curtain waits for, so the curtain waits for a megabyte.
 *
 * The gate has two halves, and it needs both. A fat topic must come back inside
 * the budget with `total` still counting the whole thread and fewer messages
 * than were asked for, which is the signal the client already reads to mark the
 * history partial and complete it with `before`. A topic of tiny rows must
 * still come back WHOLE: a budget that also trims the cheap case would break
 * the tail-first reveal for every normal chat (`tests/e2e/chat-tail-first`).
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ContentBlock } from "../../shared/types";
import { HISTORY_PAGE_MAX_BYTES } from "../../shared/history-paging";

const TEST_DATA = testTmpDir("history-page-bytes-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

/** Text that SURVIVES the lean stripping: this is the weight the budget sees. */
function prose(seed: string, kb: number): string {
  const line = `${seed} :: a line of an assistant answer, about as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/** `turns` user+assistant pairs, each assistant carrying ~`kb` of lean text. */
function seedThread(ctx: AppContext, sessionKey: string, prefix: string, turns: number, kb: number): void {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < turns; i++) {
    const u = `${prefix}-u${i}`;
    msgs.push({ id: u, role: "user", content: `question ${i}`, timestamp: new Date(Date.now() + i * 2000).toISOString(), parentId });
    const text = prose(`${prefix}-${i}`, kb);
    const blocks: ContentBlock[] = [{ kind: "text", text } as ContentBlock];
    const a = `${prefix}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: text, timestamp: new Date(Date.now() + i * 2000 + 1000).toISOString(), parentId: u, blocks });
    parentId = a;
  }
  ctx.saveLocalMessages(sessionKey, msgs);
}

type Answer = { status: number; messages: StoredMessage[]; total: number; bytes: number };

async function historyCaller(sessionKey: string, turns: number, kb: number): Promise<(query: string) => Promise<Answer>> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  seedThread(ctx, sessionKey, sessionKey.replace(/[^a-z0-9]/gi, ""), turns, kb);
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  return async (query: string) => {
    const url = new URL(`http://h${path}?${query}`);
    const resp = (await router(new Request(url), url, path, "GET"))!;
    const body = await resp.text();
    const parsed = JSON.parse(body);
    return { status: resp.status, messages: parsed.messages, total: parsed.total, bytes: body.length };
  };
}

describe("first page of /api/history", () => {
  test("a fat topic answers inside the budget, and says so by keeping `total`", async () => {
    // 20 turns = 40 messages, ~60 KB of lean text on each assistant row.
    const ask = await historyCaller("fat:budget", 20, 60);
    const page = await ask("limit=40");

    expect(page.status).toBe(200);
    // The whole thread is still declared: this is what the client compares its
    // own `messages.length` against to know the page is partial.
    expect(page.total).toBe(40);
    expect(page.messages.length).toBeLessThan(40);
    expect(page.messages.length).toBeGreaterThan(0);
    // Budget plus the one message that broke it, plus the envelope.
    expect(page.bytes).toBeLessThan(HISTORY_PAGE_MAX_BYTES + 128 * 1024);
    // The MIRROR: the same fixture without the cap (`limit: 0`, the callers
    // that need the whole thread) blows straight through it. Without this the
    // budget above would prove nothing about the fixture being fat.
    const whole = await ask("limit=0");
    expect(whole.messages.length).toBe(40);
    expect(whole.bytes).toBeGreaterThan(HISTORY_PAGE_MAX_BYTES * 4);
  });

  test("the page is the TAIL: the last message is always there", async () => {
    const ask = await historyCaller("fat:tail", 20, 60);
    const page = await ask("limit=40");
    const whole = await ask("limit=0");
    expect(page.messages[page.messages.length - 1]!.id).toBe(whole.messages[whole.messages.length - 1]!.id);
  });

  test("a topic of tiny rows still comes back whole", async () => {
    // The cheap case, which is nearly every chat: the budget must not touch it.
    const ask = await historyCaller("thin:budget", 20, 0.05);
    const page = await ask("limit=40");
    expect(page.total).toBe(40);
    expect(page.messages.length).toBe(40);
    expect(page.bytes).toBeLessThan(HISTORY_PAGE_MAX_BYTES);
  });

  test("a single message fatter than the budget is still served", async () => {
    // The floor: a payload collapsed to zero rows is a defect, not a saving.
    const ask = await historyCaller("fat:floor", 1, 400);
    const page = await ask("limit=40");
    expect(page.messages.length).toBeGreaterThan(0);
  });
});
