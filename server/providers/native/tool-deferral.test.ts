/**
 * MCP schemas deferred on the native engine: out of the prefix, loaded on
 * request, and a prefix that does not move when a tool is found.
 *
 * @covers MCPSRV-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, toolResultContent, type AgentMessage } from "./agent-loop";
import { overheadCharsFor } from "./context-window";
import { applyPromptCache } from "../prompt-cache";
import { referencedTools, runToolSearch, TOOL_SEARCH_NAME, withDeferredMcp, type OfferedTool } from "./tool-deferral";
import type { ToolSpec } from "./tools";
import type { StreamHandler } from "../types";

const spec = (name: string, description = name): ToolSpec => ({ name, description, input_schema: { type: "object", properties: { q: { type: "string" } } } });
const READ = spec("read_file", "Read a file");
const WEATHER = spec("mcp__demo__weather", "Weather forecast for a city");
const STOCKS = spec("mcp__demo__stocks", "Stock price for a ticker");
const SEARCH = spec("mcp__exa__web_search_exa", "Search the web with Exa");
const OFFERED = [READ, WEATHER, STOCKS, SEARCH];

const callOf = (name: string, id = `tu_${name}`): AgentMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] });
const resultOf = (id: string, content: unknown): AgentMessage => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] });
const byName = (tools: OfferedTool[], name: string) => tools.find((t) => t.name === name);

describe("withDeferredMcp", () => {
  test("MCP schemas go deferred, native tools stay as they are, tool_search names what is deferred", () => {
    const tools = withDeferredMcp(OFFERED, []);
    expect(byName(tools, "read_file")).toBe(READ);
    for (const t of [WEATHER, STOCKS, SEARCH]) expect(byName(tools, t.name)?.defer_loading).toBe(true);
    const search = byName(tools, TOOL_SEARCH_NAME)!;
    expect(search.defer_loading).toBeUndefined();
    for (const t of [WEATHER, STOCKS, SEARCH]) expect(search.description).toContain(t.name);
    // Loaded tools first, deferred last: the cache mark goes on the last loaded one.
    const firstDeferred = tools.findIndex((t) => t.defer_loading);
    expect(tools.slice(firstDeferred).every((t) => t.defer_loading)).toBe(true);
  });

  test("no MCP tool, nothing to do", () => {
    const tools = [READ];
    expect(withDeferredMcp(tools, [])).toBe(tools);
  });

  test("TOPICS_TOOL_SEARCH=off sends everything loaded", () => {
    const before = process.env.TOPICS_TOOL_SEARCH;
    process.env.TOPICS_TOOL_SEARCH = "off";
    try {
      expect(withDeferredMcp(OFFERED, [])).toBe(OFFERED);
    } finally {
      if (before === undefined) delete process.env.TOPICS_TOOL_SEARCH; else process.env.TOPICS_TOOL_SEARCH = before;
    }
  });

  test("a referenced tool that left the fleet is still declared, as a stub that says it is gone", () => {
    // The API answers 400 to a history that references a tool missing from
    // `tools`, and the reference never leaves the history.
    const history = [callOf(TOOL_SEARCH_NAME, "tu_s"), resultOf("tu_s", [{ type: "tool_reference", tool_name: WEATHER.name }])];
    for (const offered of [[READ, STOCKS, SEARCH], [READ]]) {
      const gone = byName(withDeferredMcp(offered, history), WEATHER.name);
      expect(gone?.defer_loading).toBe(true);
      expect(gone?.description).toContain("No longer available");
    }
  });

  test("a call whose reference was lost keeps its schema loaded (rebuilt history)", () => {
    const history = [callOf(WEATHER.name), resultOf(`tu_${WEATHER.name}`, "18C")];
    const tools = withDeferredMcp(OFFERED, history);
    expect(byName(tools, WEATHER.name)?.defer_loading).toBeUndefined();
    expect(byName(tools, STOCKS.name)?.defer_loading).toBe(true);
    expect(byName(tools, TOOL_SEARCH_NAME)!.description).not.toContain(WEATHER.name);
  });

  test("found and called in the live history: the list does not move", () => {
    const before = withDeferredMcp(OFFERED, []);
    const history = [
      callOf(TOOL_SEARCH_NAME, "tu_s"),
      resultOf("tu_s", [{ type: "tool_reference", tool_name: WEATHER.name }]),
      callOf(WEATHER.name),
      resultOf(`tu_${WEATHER.name}`, "18C"),
    ];
    expect(JSON.stringify(withDeferredMcp(OFFERED, history))).toBe(JSON.stringify(before));
  });
});

describe("runToolSearch", () => {
  const catalog = [WEATHER, STOCKS, SEARCH];

  test("select: exact names, or the tool part after the server", () => {
    expect(runToolSearch({ query: "select:mcp__demo__stocks,web_search_exa" }, catalog).references)
      .toEqual([STOCKS.name, SEARCH.name]);
  });

  test("select: loads every name asked for, past max_results, and a bare name from every server", () => {
    const many = Array.from({ length: 7 }, (_, i) => spec(`mcp__s${i}__echo`));
    expect(runToolSearch({ query: `select:${many.map((t) => t.name).join(",")}` }, many).references).toHaveLength(7);
    expect(runToolSearch({ query: "select:echo" }, many.slice(0, 2)).references).toEqual([many[0]!.name, many[1]!.name]);
  });

  test("keywords rank the name above the description, + requires a word", () => {
    expect(runToolSearch({ query: "weather" }, catalog).references).toEqual([WEATHER.name]);
    expect(runToolSearch({ query: "demo +ticker" }, catalog).references).toEqual([STOCKS.name]);
    expect(runToolSearch({ query: "demo", max_results: 1 }, catalog).references).toHaveLength(1);
  });

  test("no match: a text listing what exists, and no references", () => {
    const out = runToolSearch({ query: "calendar" }, catalog);
    expect(out.references).toBeUndefined();
    expect(out.content).toContain(WEATHER.name);
  });

  test("the result sent to the API is references only", async () => {
    const out = runToolSearch({ query: "weather" }, catalog);
    expect(await toolResultContent(out)).toEqual([{ type: "tool_reference", tool_name: WEATHER.name }]);
  });
});

describe("prefix accounting", () => {
  test("the cache mark goes on the last loaded tool, never on a deferred one", () => {
    const body = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }], tools: withDeferredMcp(OFFERED, []).map((t) => ({ ...t })) };
    applyPromptCache(body as never);
    const marked = body.tools.filter((t) => "cache_control" in t);
    expect(marked.map((t) => t.name)).toEqual([TOOL_SEARCH_NAME]);
  });

  test("the context estimate counts loaded tools only", () => {
    const tools = withDeferredMcp(OFFERED, []);
    const loaded = tools.filter((t) => !t.defer_loading);
    expect(overheadCharsFor({ tools: () => tools }, "")).toBe(JSON.stringify(loaded).length);
  });
});

describe("in the agent loop", () => {
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  let home: string;
  let ws: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "deferral-home-"));
    ws = mkdtempSync(join(tmpdir(), "deferral-ws-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "fake-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
    }));
    process.env.HOME = home;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    for (const d of [home, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const toolRound = (id: string, name: string, input: unknown) => sse([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
  ]);
  const endRound = sse([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ]);
  const silent: StreamHandler = { onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {} };

  async function turn(allowTool?: (name: string) => boolean) {
    const rounds = [toolRound("tu_s", TOOL_SEARCH_NAME, { query: "weather" }), toolRound("tu_w", WEATHER.name, { q: "Rome" }), endRound];
    const sent: Array<{ tools: OfferedTool[]; messages: AgentMessage[] }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(rounds.shift() ?? endRound, { status: 200 });
    }) as unknown as typeof fetch;
    const history: AgentMessage[] = [{ role: "user", content: "weather in Rome?" }];
    await runAgentTurn({
      model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply",
      tools: () => OFFERED, ...(allowTool ? { allowTool } : {}),
    }, silent);
    return sent;
  }

  test("search, call, answer: three rounds with the same tool list, the search answered by references", async () => {
    const sent = await turn();
    expect(sent).toHaveLength(3);
    expect(byName(sent[0]!.tools, WEATHER.name)?.defer_loading).toBe(true);
    expect(JSON.stringify(sent[1]!.tools)).toBe(JSON.stringify(sent[0]!.tools));
    expect(JSON.stringify(sent[2]!.tools)).toBe(JSON.stringify(sent[0]!.tools));
    const results = sent[1]!.messages.at(-1)!.content as { type: string; content?: unknown }[];
    expect(results[0]!.content).toEqual([{ type: "tool_reference", tool_name: WEATHER.name }]);
  });

  test("a tool that leaves the fleet between two turns does not turn the chat into a 400", async () => {
    // The fake API applies the real rule: every referenced tool needs a definition.
    const rounds = [toolRound("tu_s", TOOL_SEARCH_NAME, { query: "weather" }), toolRound("tu_w", WEATHER.name, { q: "Rome" }), endRound];
    const statuses: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools: OfferedTool[]; messages: AgentMessage[] };
      const declared = new Set(body.tools.map((t) => t.name));
      const missing = [...referencedTools(body.messages)].find((n) => !declared.has(n));
      if (missing) {
        statuses.push(400);
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: `Tool reference '${missing}' not found in available tools` } }, { status: 400 });
      }
      statuses.push(200);
      return new Response(rounds.shift() ?? endRound, { status: 200 });
    }) as unknown as typeof fetch;
    const history: AgentMessage[] = [{ role: "user", content: "weather in Rome?" }];
    const base = { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply" as const };
    await runAgentTurn({ ...base, tools: () => OFFERED }, silent);
    // The demo server is remounted without its weather tool.
    history.push({ role: "user", content: "and tomorrow?" });
    const second = await runAgentTurn({ ...base, tools: () => [READ, STOCKS, SEARCH] }, silent);
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(second.turnEnd.end).not.toBe("error");
  });

  test("a sub-agent policy does not block the search itself", async () => {
    const sent = await turn((name) => name.startsWith("mcp__"));
    const results = sent[1]!.messages.at(-1)!.content as { type: string; content?: unknown; is_error?: boolean }[];
    expect(results[0]!.is_error).toBeUndefined();
    expect(results[0]!.content).toEqual([{ type: "tool_reference", tool_name: WEATHER.name }]);
  });
});
