/**
 * How much a tool call's ARGUMENTS weigh when a chat opens.
 *
 * `history-payload-weight.test.ts` guards the two cuts made before this one:
 * no text travels twice, and the three text blobs of `detail` go blank. What
 * it does not see is everything else a tool call carries: `args` (the whole
 * `content` of a Write, the `new_string` of an Edit, a 30 KB script in
 * `command`) and the long non-text fields of `detail` (`command`, `oldString`,
 * `newString`, an MCP `args` object). Measured on the live DB on 2026-09-05:
 * on a 17-message topic the history response weighed 2.6 MB and took 1.4 s,
 * 98% of it in tool blocks, and inside a Bash block `args` was 33 KB and
 * `detail` another 33 KB against a `detailBytes` of 174 - the strip had
 * removed 174 characters out of 66 KB.
 *
 * Three properties, in the shape of WIRE-09:
 *
 *  1. WEIGHT, in bytes, on a realistic fixture: one message with 20 tool calls
 *     of 30 KB of args each (and the same text typed in `detail`) stays under
 *     a fixed ceiling. The bar is bytes, not a ratio.
 *  2. NOTHING WAS LOST: the detail route gives back the whole `args` and the
 *     whole `detail`, and the counters on the wire say exactly how much was
 *     cut. A trim that also trimmed the answer would pass test 1 and be a
 *     regression.
 *  3. THE MIRROR: the same fixture in its previous form (the text whole) breaks
 *     the ceiling. A ceiling nobody has seen broken measures nothing.
 *
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";
import { WIRE_STRING_PREVIEW_CHARS } from "../../shared/lean-tool-call";

const ROOT = testTmpDir("history-args-weight");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const TOOLS = 20;
/** 30 KB per tool call: the size of the Bash `args` measured on the live DB. */
const ARG_KB = 30;

/** A script with a recognisable head and a recognisable tail, ~ARG_KB long. */
function script(seed: string): string {
  const head = `echo head-${seed}\n`;
  const line = `echo filler ${seed} :: one line of a long script that the closed row never shows\n`;
  const body = line.repeat(Math.ceil((ARG_KB * 1024) / line.length));
  return `${head}${body}echo TAIL-${seed}`;
}

/**
 * The fixture: even calls are a Bash whose 30 KB script sits in `args.command`
 * AND in `detail.command`; odd calls are an Edit whose 30 KB `new_string` sits
 * in `args` AND in `detail.newString`. Both are the shapes the provider
 * persists: the text typed in `detail`, the raw arguments next to it. A short
 * field travels alongside on every call so the test can prove it survives.
 */
function toolCall(id: string, i: number): ToolCall {
  const text = script(id);
  if (i % 2 === 0) {
    return {
      id, name: "Bash", status: "success",
      args: { command: text, description: `step ${i}` },
      detail: { type: "shell", command: text, cwd: "/repo", output: "ok" },
      result: "ok",
    };
  }
  return {
    id, name: "Edit", status: "success",
    args: { file_path: `/repo/src/file-${i}.ts`, old_string: `old-${i}`, new_string: text },
    detail: { type: "edit", filePath: `/repo/src/file-${i}.ts`, oldString: `old-${i}`, newString: text },
    result: `edited file-${i}.ts`,
  };
}

function seedThread(ctx: AppContext, sessionKey: string, p: string): { calls: ToolCall[]; assistantId: string } {
  const u = `${p}-u`;
  const a = `${p}-a`;
  const calls: ToolCall[] = [];
  const blocks: ContentBlock[] = [];
  for (let t = 0; t < TOOLS; t++) {
    const tc = toolCall(`${p}-${t}`, t);
    calls.push(tc);
    blocks.push({ kind: "tool", toolCall: tc } as ContentBlock);
  }
  blocks.push({ kind: "text", text: "done" } as ContentBlock);
  const msgs: StoredMessage[] = [
    { id: u, role: "user", content: "do twenty things", timestamp: new Date(Date.now() - 2000).toISOString(), parentId: null },
    { id: a, role: "assistant", content: "done", timestamp: new Date(Date.now() - 1000).toISOString(), parentId: u, blocks, toolCalls: calls },
  ];
  ctx.saveLocalMessages(sessionKey, msgs);
  return { calls, assistantId: a };
}

async function historyPayload(sessionKey: string): Promise<{ body: string; json: { messages: StoredMessage[] }; ctx: AppContext; seeded: ReturnType<typeof seedThread> }> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  const seeded = seedThread(ctx, sessionKey, sessionKey.replace(/[^a-z0-9]/gi, ""));
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const url = new URL(`http://h${path}?limit=0`);
  const resp = (await router(new Request(url), url, path, "GET"))!;
  expect(resp.status).toBe(200);
  const body = await resp.text();
  return { body, json: JSON.parse(body), ctx, seeded };
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

/**
 * The ceiling. Per call the wire keeps two previews of WIRE_STRING_PREVIEW_CHARS
 * (Bash: args.command + detail.command; Edit: args.new_string +
 * detail.newString), the short fields and the counters: ~1.3 KB. Twenty calls
 * plus the two messages around them: ~30 KB measured. 64 KB leaves room for a
 * field or two nobody has added yet and none at all for a single 30 KB script.
 */
const CEILING_BYTES = 64 * 1024;

describe("weight of the tool ARGUMENTS on /api/history", () => {
  test("WEIGHT: 20 tool calls with 30 KB of args each stay under the ceiling", async () => {
    const { body, json } = await historyPayload("topic:args-weight");
    const calls = wireToolCalls(json.messages);
    expect(calls.length).toBe(TOOLS);
    expect(body.length).toBeLessThan(CEILING_BYTES);
    // Floor: twenty calls with their heads and their short fields do not fit
    // in a few KB; a payload that small would have lost the calls themselves.
    expect(body.length).toBeGreaterThan(TOOLS * WIRE_STRING_PREVIEW_CHARS);
  });

  test("what the CLOSED row draws survives: the head of the command, the path, the short fields", async () => {
    const { json } = await historyPayload("topic:args-head");
    const calls = wireToolCalls(json.messages);
    for (const [i, tc] of calls.entries()) {
      const args = tc.args as Record<string, string>;
      const detail = tc.detail as Record<string, string>;
      if (i % 2 === 0) {
        expect(args.command.startsWith(`echo head-${tc.id}`)).toBe(true);
        expect(args.command.length).toBe(WIRE_STRING_PREVIEW_CHARS);
        expect(args.command.includes("TAIL-")).toBe(false);
        expect(args.description).toBe(`step ${i}`);
        expect(detail.command.length).toBe(WIRE_STRING_PREVIEW_CHARS);
        expect(detail.cwd).toBe("/repo");
        expect(detail.output).toBe("");
      } else {
        expect(args.file_path).toBe(`/repo/src/file-${i}.ts`);
        expect(args.old_string).toBe(`old-${i}`);
        expect(args.new_string.length).toBe(WIRE_STRING_PREVIEW_CHARS);
        expect(detail.filePath).toBe(`/repo/src/file-${i}.ts`);
        expect(detail.newString.length).toBe(WIRE_STRING_PREVIEW_CHARS);
      }
      // The counters declare EXACTLY what was cut.
      const full = script(tc.id);
      expect(tc.argsBytes).toBe(full.length - WIRE_STRING_PREVIEW_CHARS);
      const textBlank = i % 2 === 0 ? "ok".length : 0;
      expect(tc.detailBytes).toBe(full.length - WIRE_STRING_PREVIEW_CHARS + textBlank);
    }
  });

  test("NOTHING WAS LOST: the detail route gives back the whole args and the whole detail", async () => {
    const { json, ctx, seeded } = await historyPayload("topic:args-route");
    const { createToolDetailRouter } = await import("../../server/routes/history");
    const detailRouter = createToolDetailRouter(ctx);
    const wire = wireToolCalls(json.messages);
    for (const idx of [0, 1]) {
      const tc = wire[idx];
      const path = `/api/messages/${encodeURIComponent(seeded.assistantId)}/tool/${encodeURIComponent(tc.id)}/detail`;
      const url = new URL(`http://h${path}`);
      const resp = await detailRouter(new Request(url), url, path, "GET");
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(200);
      const { detail, args } = await resp!.json() as { detail: Record<string, string>; args: Record<string, string> };
      const full = script(tc.id);
      if (idx === 0) {
        expect(args.command).toBe(full);
        expect(detail.command).toBe(full);
        expect(detail.output).toBe("ok");
      } else {
        expect(args.new_string).toBe(full);
        expect(detail.newString).toBe(full);
      }
      expect(full.endsWith(`echo TAIL-${tc.id}`)).toBe(true);
    }
  });

  test("the MIRROR: the same fixture with its text whole breaks the ceiling", async () => {
    const { json, seeded } = await historyPayload("topic:args-mirror");
    // Put the seeded calls (text whole) back where the wire had the previews.
    const bySeed = new Map(seeded.calls.map((tc) => [tc.id, tc]));
    const fat = json.messages.map((m) => ({
      ...m,
      blocks: (m.blocks ?? []).map((b) => {
        const tc = (b as { toolCall?: ToolCall }).toolCall;
        return tc ? { ...b, toolCall: bySeed.get(tc.id) ?? tc } : b;
      }),
    }));
    const fatBytes = JSON.stringify({ ...json, messages: fat }).length;
    expect(fatBytes).toBeGreaterThan(CEILING_BYTES);
    // And it is not a near miss: twenty scripts of 30 KB, twice each.
    expect(fatBytes).toBeGreaterThan(TOOLS * 2 * ARG_KB * 1024);
  });
});
