/**
 * Unit coverage for the topics-app MCP server (server/mcp/topics-mcp-server.ts).
 *
 * The module guards `main()` behind `import.meta.main` so importing it from
 * the test file does NOT spin up the stdio server. We exercise the exported
 * pure functions instead:
 *   - `parseArgs` — argv parsing + required-arg validation
 *   - `handleMessage` — JSON-RPC initialize / tools/list / tools/call wiring
 *   - `callOpenBrowserPane` — HTTP call shape (URL, headers, body)
 *
 * The HTTP layer is exercised via a tiny stub `fetch` so we don't have to
 * spin up the topics-app server. callOpenBrowserPane accepts the fetchImpl
 * as a parameter precisely to make this test possible.
 */
import { describe, test, expect } from "bun:test";
import {
  parseArgs,
  callOpenBrowserPane,
  callRunScript,
  callListProcesses,
  callReadProcessOutput,
  callStopProcess,
  callListTasks,
  callCreateTask,
  callGetTask,
  callUpdateTask,
  callCommentTask,
  callSpawnAgent,
  callSendToAgent,
  callReadAgent,
  callListAgents,
  callStopAgent,
  callSwitchTopic,
  callNewTopic,
  callCreateProject,
  callOpenProject,
  callMoveToProject,
  handleMessage,
} from "./topics-mcp-server";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses base-url + session-key", () => {
    const args = parseArgs([
      "--base-url=http://localhost:3333",
      "--session-key=topic:abcdef",
    ]);
    expect(args.baseUrl).toBe("http://localhost:3333");
    expect(args.sessionKey).toBe("topic:abcdef");
    expect(args.gatewayToken).toBeUndefined();
  });

  test("strips trailing slash from baseUrl", () => {
    const args = parseArgs([
      "--base-url=http://localhost:3333/",
      "--session-key=s",
    ]);
    expect(args.baseUrl).toBe("http://localhost:3333");
  });

  test("captures optional gateway-token", () => {
    const args = parseArgs([
      "--base-url=http://x",
      "--session-key=s",
      "--gateway-token=secret-123",
    ]);
    expect(args.gatewayToken).toBe("secret-123");
  });

  test("throws when --base-url missing", () => {
    expect(() => parseArgs(["--session-key=s"])).toThrow(/base-url is required/);
  });

  test("throws when --session-key missing", () => {
    expect(() => parseArgs(["--base-url=http://x"])).toThrow(/session-key is required/);
  });

  test("ignores unknown args", () => {
    const args = parseArgs([
      "--base-url=http://x",
      "--session-key=s",
      "--unknown-flag=ignored",
      "garbage",
    ]);
    expect(args.baseUrl).toBe("http://x");
    expect(args.sessionKey).toBe("s");
  });
});

// ---------------------------------------------------------------------------
// callOpenBrowserPane
// ---------------------------------------------------------------------------

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return impl as typeof fetch;
}

describe("callOpenBrowserPane", () => {
  test("POSTs to the session-keyed open-pane endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(
        JSON.stringify({ url: "https://example.com/final", title: "Example Domain" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await callOpenBrowserPane(
      { baseUrl: "http://localhost:3333", sessionKey: "topic:abc def" },
      { url: "https://example.com" },
      fetchImpl,
    );

    expect(seen.url).toBe(
      "http://localhost:3333/api/sessions/topic%3Aabc%20def/browser/open-pane",
    );
    expect(seen.init?.method).toBe("POST");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Gateway-Token"]).toBeUndefined();
    expect(seen.init?.body).toBe(JSON.stringify({ url: "https://example.com" }));
    expect(result).toEqual({ url: "https://example.com/final", title: "Example Domain" });
  });

  test("forwards gateway-token as X-Gateway-Token header", async () => {
    let seenHeader: string | undefined;
    const fetchImpl = stubFetch(async (_url, init) => {
      seenHeader = (init?.headers as Record<string, string>)?.["X-Gateway-Token"];
      return new Response(JSON.stringify({ url: "x", title: "" }), { status: 200 });
    });

    await callOpenBrowserPane(
      { baseUrl: "http://x", sessionKey: "s", gatewayToken: "tok-abc" },
      { url: "https://example.com" },
      fetchImpl,
    );

    expect(seenHeader).toBe("tok-abc");
  });

  test("throws on missing url argument", async () => {
    const fetchImpl = stubFetch(async () => new Response("", { status: 200 }));
    await expect(
      callOpenBrowserPane(
        { baseUrl: "http://x", sessionKey: "s" },
        {},
        fetchImpl,
      ),
    ).rejects.toThrow(/url.*required/i);
  });

  test("throws on non-2xx response with server message", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response("Topic not found", { status: 404, statusText: "Not Found" }),
    );
    await expect(
      callOpenBrowserPane(
        { baseUrl: "http://x", sessionKey: "s" },
        { url: "https://example.com" },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 404.*Topic not found/);
  });

  test("falls back to input url + empty title when server omits fields", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await callOpenBrowserPane(
      { baseUrl: "http://x", sessionKey: "s" },
      { url: "https://example.com/foo" },
      fetchImpl,
    );
    expect(result).toEqual({ url: "https://example.com/foo", title: "" });
  });

  test("surfaces server-side { error } as throw", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "Browser service disabled" }), { status: 200 }),
    );
    await expect(
      callOpenBrowserPane(
        { baseUrl: "http://x", sessionKey: "s" },
        { url: "https://example.com" },
        fetchImpl,
      ),
    ).rejects.toThrow(/Browser service disabled/);
  });
});

// ---------------------------------------------------------------------------
// handleMessage — JSON-RPC routing
// ---------------------------------------------------------------------------

const ARGS = { baseUrl: "http://localhost:3333", sessionKey: "s" };

describe("handleMessage", () => {
  test("initialize → returns protocolVersion + tools capability", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      ARGS,
    );
    expect(resp).not.toBeNull();
    expect(resp!.id).toBe(1);
    const result = resp!.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe("topics-app");
  });

  test("tools/list → returns the full Phase-1 tool set", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ARGS,
    );
    const tools = (resp!.result as any).tools as Array<{ name: string; inputSchema: any }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "open_browser_pane",
      "import_chrome",
      // Ref-based browser tools — projected from browser-tool-spec.ts.
      "browser_observe",
      "browser_act",
      "browser_extract",
      "browser_get_text",
      "browser_screenshot",
      "browser_read_screen",
      "browser_console",
      "browser_eval",
      "browser_save_state",
      "browser_load_state",
      "browser_status",
      "browser_upload",
      "run_script",
      "list_processes",
      "read_process_output",
      "stop_process",
      "list_tasks",
      "create_task",
      "get_task",
      "update_task",
      "comment_task",
      "move_session_to_project",
      "spawn_agent",
      "send_to_agent",
      "read_agent",
      "list_agents",
      "stop_agent",
      "switch_topic",
      "new_topic",
      "create_project",
      "open_project",
    ]);
    const browser = tools.find((t) => t.name === "open_browser_pane")!;
    expect(browser.inputSchema.required).toEqual(["url"]);
    expect(browser.inputSchema.properties.url.type).toBe("string");
    expect(tools.find((t) => t.name === "run_script")!.inputSchema.required).toEqual(["script"]);
    expect(tools.find((t) => t.name === "update_task")!.inputSchema.required).toEqual(["task_id"]);
    expect(tools.find((t) => t.name === "create_task")!.inputSchema.required).toEqual(["text"]);
    expect(tools.find((t) => t.name === "comment_task")!.inputSchema.required).toEqual(["task_id", "content"]);
  });

  test("tools/call routes run_script through the registry", async () => {
    // Patch global fetch since handleMessage doesn't take a fetchImpl.
    const orig = globalThis.fetch;
    let seenUrl = "";
    (globalThis as any).fetch = stubFetch(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ processId: "p1", pid: 42 }), { status: 200 });
    });
    try {
      const resp = await handleMessage(
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run_script", arguments: { script: "test" } } },
        ARGS,
      );
      const result = resp!.result as any;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("processId=p1");
      expect(seenUrl).toContain("/api/sessions/s/scripts/run");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("tools/call with unknown name → -32601 error", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } },
      ARGS,
    );
    expect(resp!.error).toEqual({ code: -32601, message: "Unknown tool: nope" });
  });

  test("unknown method → -32601 Method not found", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "completely/made-up" },
      ARGS,
    );
    expect(resp!.error?.code).toBe(-32601);
    expect(resp!.error?.message).toContain("Method not found");
  });

  test("notification (notifications/initialized) → null response", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: null, method: "notifications/initialized" },
      ARGS,
    );
    expect(resp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase-1 bridge tools
// ---------------------------------------------------------------------------

describe("callRunScript", () => {
  test("POSTs scriptName to the session-keyed run endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ processId: "ab12", pid: 99 }), { status: 200 });
    });
    const text = await callRunScript(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { script: "dev" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/scripts/run");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ scriptName: "dev" }));
    expect(text).toContain("processId=ab12");
    expect(text).toContain("pid=99");
  });

  test("throws when script arg missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callRunScript({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/script.*required/i);
  });

  test("surfaces 400 + available scripts list from the gate", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: 'Script "nope" is not defined in package.json', available: ["dev", "test"] }), { status: 400 }),
    );
    await expect(
      callRunScript({ baseUrl: "http://x", sessionKey: "s" }, { script: "nope" }, fetchImpl),
    ).rejects.toThrow(/not defined.*available: dev, test/);
  });
});

describe("callListProcesses", () => {
  test("formats running + recent into compact lines", async () => {
    const fetchImpl = stubFetch(async (url) => {
      expect(String(url)).toBe("http://x/api/sessions/s/scripts");
      return new Response(JSON.stringify({ scripts: [
        { status: "running", scriptName: "dev", processId: "p1", pid: 10, ports: [5173] },
        { status: "done", scriptName: "test", processId: "p2", pid: 11, exitCode: 0 },
      ] }), { status: 200 });
    });
    const text = await callListProcesses({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(text).toContain("[running] dev id=p1 pid=10 ports=5173");
    expect(text).toContain("[done] test id=p2 pid=11 exit=0");
  });

  test("handles empty list", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ scripts: [] }), { status: 200 }));
    const text = await callListProcesses({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(text).toMatch(/no processes/i);
  });
});

describe("callReadProcessOutput", () => {
  test("passes offset and returns output + footer", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({ output: "line1\nline2", offset: 2, status: "running", done: false }), { status: 200 });
    });
    const text = await callReadProcessOutput(
      { baseUrl: "http://x", sessionKey: "s" },
      { process_id: "p1", offset: 5 },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/s/scripts/p1/output?offset=5");
    expect(text).toContain("line1\nline2");
    expect(text).toContain("[offset=2 status=running]");
  });

  test("truncates very long output to the tail", async () => {
    const big = "x".repeat(20000);
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ output: big, offset: 1, status: "done", done: true, exitCode: 0 }), { status: 200 }),
    );
    const text = await callReadProcessOutput({ baseUrl: "http://x", sessionKey: "s" }, { process_id: "p1" }, fetchImpl);
    expect(text).toMatch(/truncated/i);
    expect(text).toContain("done");
    expect(text).toContain("exit=0");
    expect(text.length).toBeLessThan(9000);
  });

  test("throws when process_id missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callReadProcessOutput({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/process_id.*required/i);
  });
});

describe("callStopProcess", () => {
  test("POSTs to the stop endpoint", async () => {
    const seen: { url?: string; method?: string } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.method = init?.method;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const text = await callStopProcess({ baseUrl: "http://x", sessionKey: "s" }, { process_id: "p9" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/scripts/p9/stop");
    expect(seen.method).toBe("POST");
    expect(text).toBe("stopped p9");
  });

  test("surfaces 404 when already stopped", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "Process not found or already stopped" }), { status: 404 }),
    );
    await expect(
      callStopProcess({ baseUrl: "http://x", sessionKey: "s" }, { process_id: "gone" }, fetchImpl),
    ).rejects.toThrow(/already stopped/);
  });
});

describe("callListTasks", () => {
  test("formats tasks and forwards status filter", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({ tasks: [
        { status: "todo", text: "Write tests", id: "t1", projectId: "proj1" },
      ] }), { status: 200 });
    });
    const text = await callListTasks({ baseUrl: "http://x", sessionKey: "s" }, { status: "todo" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/tasks?status=todo");
    expect(text).toContain("[todo] Write tests (id=t1 project=proj1)");
  });

  test("omits query when no status, handles empty", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
    });
    const text = await callListTasks({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/tasks");
    expect(text).toMatch(/no tasks/i);
  });

  test("scope=all hits the cross-project feed", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({ tasks: [
        { status: "todo", text: "A", id: "t1", project_id: "p1" },
        { status: "review", text: "B", id: "t2", project_id: "p2" },
      ] }), { status: 200 });
    });
    const text = await callListTasks({ baseUrl: "http://x", sessionKey: "s" }, { scope: "all" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/tasks?scope=all");
    expect(text).toContain("project=p1");
    expect(text).toContain("project=p2");
  });
});

describe("callUpdateTask", () => {
  test("PATCHes to the session-scoped task endpoint (no project_id)", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ id: "t1", status: "in_progress" }), { status: 200 });
    });
    const text = await callUpdateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", status: "in_progress" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/s/tasks/t1");
    expect(seen.init?.method).toBe("PATCH");
    expect(seen.init?.body).toBe(JSON.stringify({ status: "in_progress" }));
    expect(text).toBe("task t1 → in_progress");
  });

  test("sends only the provided patch fields", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t1", status: "todo" }), { status: 200 });
    });
    await callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", priority: 4, assignee: "claude" }, fetchImpl);
    expect(seen.init?.body).toBe(JSON.stringify({ priority: 4, assignee: "claude" }));
  });

  test("throws when task_id missing or no patch given", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { status: "todo" }, fetchImpl),
    ).rejects.toThrow(/task_id.*required/i);
    await expect(
      callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1" }, fetchImpl),
    ).rejects.toThrow(/at least one/i);
  });

  test("surfaces server error (e.g. agent cannot complete)", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "agents deliver to 'review'; only a human moves 'review' → 'done'" }), { status: 409 }),
    );
    await expect(
      callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", status: "done" }, fetchImpl),
    ).rejects.toThrow(/only a human/);
  });
});

describe("callCreateTask", () => {
  test("POSTs text (+optional fields) to the session tasks endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ id: "t9", status: "todo" }), { status: 201 });
    });
    const text = await callCreateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { text: "Do the thing", priority: 3, idempotency_key: "K1" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/s/tasks");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ text: "Do the thing", priority: 3, idempotency_key: "K1" }));
    expect(text).toContain("created task t9 [todo]");
  });

  test("throws when text missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callCreateTask({ baseUrl: "http://x", sessionKey: "s" }, { text: "   " }, fetchImpl),
    ).rejects.toThrow(/text.*required/i);
  });
});

describe("callGetTask", () => {
  test("renders the task head + comment thread", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({
      task: { id: "t1", status: "review", text: "Ship it", assigned_to: "claude" },
      comments: [{ author: "claude", content: "done, ready for review" }, { author: "attilio", content: "looks good" }],
    }), { status: 200 }));
    const text = await callGetTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1" }, fetchImpl);
    expect(text).toContain("[review] Ship it (id=t1 @claude)");
    expect(text).toContain("claude: done, ready for review");
    expect(text).toContain("attilio: looks good");
  });

  test("handles no comments", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({
      task: { id: "t1", status: "todo", text: "x" }, comments: [],
    }), { status: 200 }));
    const text = await callGetTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1" }, fetchImpl);
    expect(text).toContain("(no comments)");
  });
});

describe("callCommentTask", () => {
  test("POSTs the comment to the task's comments endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ id: "c1" }), { status: 201 });
    });
    const text = await callCommentTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", content: "progress note" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/s/tasks/t1/comments");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ content: "progress note" }));
    expect(text).toContain("commented on t1");
  });

  test("throws when content missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callCommentTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", content: "" }, fetchImpl),
    ).rejects.toThrow(/content.*required/i);
  });
});

// ---------------------------------------------------------------------------
// Sub-agent orchestration
// ---------------------------------------------------------------------------

describe("callSpawnAgent", () => {
  test("POSTs prompt (+optional name/cwd) to the session-keyed spawn endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ agentId: "kid1", name: "worker", cwd: "/p" }), { status: 200 });
    });
    const text = await callSpawnAgent(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { prompt: "do it", name: "worker", cwd: "/p" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/agents/spawn");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ prompt: "do it", name: "worker", cwd: "/p" });
    expect(text).toContain("agentId=kid1");
    expect(text).toContain('read_agent(agent_id="kid1")');
  });

  test("omits name/cwd when not provided", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ agentId: "kid1" }), { status: 200 });
    });
    await callSpawnAgent({ baseUrl: "http://x", sessionKey: "s" }, { prompt: "go" }, fetchImpl);
    expect(JSON.parse(String(seen.init?.body))).toEqual({ prompt: "go" });
  });

  test("throws when prompt missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callSpawnAgent({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/prompt.*required/i);
  });

  test("surfaces a depth/concurrency 429 from the server", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "max 5 live sub-agents per session" }), { status: 429 }),
    );
    await expect(
      callSpawnAgent({ baseUrl: "http://x", sessionKey: "s" }, { prompt: "go" }, fetchImpl),
    ).rejects.toThrow(/max 5 live sub-agents/);
  });
});

describe("callSendToAgent", () => {
  test("POSTs input to the agent send endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, sent: 2 }), { status: 200 });
    });
    await callSendToAgent({ baseUrl: "http://x", sessionKey: "s" }, { agent_id: "kid1", input: "hi" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/agents/kid1/send");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ input: "hi" });
  });

  test("ownership 404 from the server surfaces as an error", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "sub-agent not found" }), { status: 404 }),
    );
    await expect(
      callSendToAgent({ baseUrl: "http://x", sessionKey: "s" }, { agent_id: "notmine", input: "x" }, fetchImpl),
    ).rejects.toThrow(/sub-agent not found/);
  });
});

describe("callReadAgent", () => {
  test("renders assistant + tool_use events and pages via since", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({
        events: [
          { type: "assistant", text: "hello" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
        nextOffset: 4096,
        source: "jsonl",
      }), { status: 200 });
    });
    const text = await callReadAgent({ baseUrl: "http://x", sessionKey: "s" }, { agent_id: "kid1", since: 100 }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/agents/kid1/read?since=100");
    expect(text).toContain("[assistant] hello");
    expect(text).toContain("[tool_use] Bash");
    expect(text).toContain("since=4096");
  });

  test("falls back to the raw buffer when the transcript isn't ready", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ events: [], nextOffset: 0, source: "buffer", buffer: "booting…" }), { status: 200 }),
    );
    const text = await callReadAgent({ baseUrl: "http://x", sessionKey: "s" }, { agent_id: "kid1" }, fetchImpl);
    expect(text).toContain("booting…");
  });
});

describe("callListAgents / callStopAgent", () => {
  test("list formats busy/idle rows", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({ agents: [
        { agentId: "kid1", name: "worker", cwd: "/p", busy: true },
      ] }), { status: 200 });
    });
    const text = await callListAgents({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/agents");
    expect(text).toContain("[busy] worker id=kid1");
  });

  test("stop POSTs to the agent stop endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const text = await callStopAgent({ baseUrl: "http://x", sessionKey: "s" }, { agent_id: "kid1" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/agents/kid1/stop");
    expect(seen.init?.method).toBe("POST");
    expect(text).toContain("stopped sub-agent kid1");
  });
});

// ---------------------------------------------------------------------------
// Topic / project control bridge (successors to {{TOPIC_*}}/{{PROJECT_*}})
// ---------------------------------------------------------------------------

describe("callSwitchTopic", () => {
  test("POSTs topicId to the session-keyed switch-topic endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, toTopicId: "t2" }), { status: 200 });
    });
    const text = await callSwitchTopic({ baseUrl: "http://x", sessionKey: "topic:abc" }, { topic_id: "t2" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/switch-topic");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ topicId: "t2" }));
    expect(text).toContain("switched to topic t2");
  });

  test("throws when topic_id missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callSwitchTopic({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/topic_id.*required/i);
  });

  test("surfaces the endpoint's 400 archived error", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "target topic is archived", code: "topic_archived" }), { status: 400 }),
    );
    await expect(
      callSwitchTopic({ baseUrl: "http://x", sessionKey: "s" }, { topic_id: "dead" }, fetchImpl),
    ).rejects.toThrow(/archived/i);
  });
});

describe("callNewTopic", () => {
  test("POSTs title to the session-keyed new-topic endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, topicId: "new1" }), { status: 200 });
    });
    const text = await callNewTopic({ baseUrl: "http://x", sessionKey: "s" }, { title: "My Findings" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/new-topic");
    expect(seen.init?.body).toBe(JSON.stringify({ title: "My Findings" }));
    expect(text).toContain('"My Findings"');
    expect(text).toContain("id=new1");
  });

  test("throws when title missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callNewTopic({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/title.*required/i);
  });
});

describe("callCreateProject", () => {
  test("POSTs name to the session-keyed create-project endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, projectPath: "/ws/Fresh" }), { status: 200 });
    });
    const text = await callCreateProject({ baseUrl: "http://x", sessionKey: "s" }, { name: "Fresh" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/create-project");
    expect(seen.init?.body).toBe(JSON.stringify({ name: "Fresh" }));
    expect(text).toContain("/ws/Fresh");
  });

  test("surfaces the endpoint's 409 collision error", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: 'project "Taken" already exists', code: "project_exists" }), { status: 409 }),
    );
    await expect(
      callCreateProject({ baseUrl: "http://x", sessionKey: "s" }, { name: "Taken" }, fetchImpl),
    ).rejects.toThrow(/already exists/i);
  });

  test("throws when name missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callCreateProject({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/name.*required/i);
  });
});

describe("callOpenProject", () => {
  test("POSTs ref to the session-keyed open-project endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, projectPath: "/ws/known" }), { status: 200 });
    });
    const text = await callOpenProject({ baseUrl: "http://x", sessionKey: "s" }, { ref: "known" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/s/open-project");
    expect(seen.init?.body).toBe(JSON.stringify({ ref: "known" }));
    expect(text).toContain("/ws/known");
  });

  test("surfaces the endpoint's 404 unknown-ref error", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "project not found (must be a project Topics already knows)" }), { status: 404 }),
    );
    await expect(
      callOpenProject({ baseUrl: "http://x", sessionKey: "s" }, { ref: "ghost" }, fetchImpl),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when ref missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callOpenProject({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/ref.*required/i);
  });
});

describe("callMoveToProject", () => {
  test("POSTs projectPath to the session-keyed move-to-project endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, paneId: "terminal:t1", projectPath: "/Users/me/Projects/foo" }), { status: 200 });
    });
    const text = await callMoveToProject(
      { baseUrl: "http://x", sessionKey: "term-1" },
      { project_path: "/Users/me/Projects/foo" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/term-1/move-to-project");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ projectPath: "/Users/me/Projects/foo" }));
    expect(text).toContain("terminal:t1");
    expect(text).toContain("/Users/me/Projects/foo");
    expect(text).toContain("de-duplicated");
  });

  test("throws when project_path missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callMoveToProject({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/project_path.*required/i);
  });
});
