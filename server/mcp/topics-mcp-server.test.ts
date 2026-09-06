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
 * @covers KANBAN-06
 */
import { describe, test, expect } from "bun:test";
import {
  parseArgs,
  callOpenBrowserPane,
  callListBrowserTabs,
  callFocusBrowserTab,
  callRunScript,
  callListProcesses,
  callReadProcessOutput,
  callWaitForProcess,
  callStopProcess,
  callListTasks,
  callCreateTask,
  callGetTask,
  callGetGoal,
  callCloseGoal,
  callSetGoal,
  callUpdateGoalSteps,
  callUpdateTask,
  callCommentTask,
  callWaitForCondition,
  callAskUserQuestion,
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
  callSendChatMessage,
  callReadChatMessages,
  callResolveTab,
  callBrowserBridge,
  handleMessage,
  toolsForProfile,
  isToolAllowedForProfile,
  ASK_LEG_MS,
  ASK_MAX_LEGS,
} from "./topics-mcp-server";
import { CHECKS_LEG_MS } from "../services/checks-gate";
import { ASK_TTL_MS } from "../lib/ask-user-bridge";

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
// Global Kanban orchestrator profile
// ---------------------------------------------------------------------------

describe("global-orchestrator MCP profile", () => {
  const GLOBAL_TASK_TOOLS = [
    "list_global_tasks",
    "get_global_task",
    "create_global_task",
    "update_global_task",
    "comment_global_task",
  ];

  test("publishes only the narrow, board-scoped task surface", () => {
    expect(toolsForProfile("global-orchestrator").map((tool) => tool.name)).toEqual(GLOBAL_TASK_TOOLS);
  });

  test("defense-in-depth rejects agent, process, browser, and ordinary task calls", () => {
    for (const name of GLOBAL_TASK_TOOLS) {
      expect(isToolAllowedForProfile("global-orchestrator", name)).toBe(true);
    }

    for (const forbidden of [
      "spawn_agent",
      "send_to_agent",
      "stop_agent",
      "run_script",
      "open_browser_pane",
      "list_tasks",
      "update_task",
      "create_task",
      "send_chat_message",
    ]) {
      expect(isToolAllowedForProfile("global-orchestrator", forbidden)).toBe(false);
    }
  });

  test("keeps the global surface out of every non-global profile and direct dispatch", () => {
    for (const profile of [undefined, "dispatch"]) {
      const advertised = toolsForProfile(profile).map((tool) => tool.name);
      for (const name of GLOBAL_TASK_TOOLS) {
        expect(advertised).not.toContain(name);
        expect(isToolAllowedForProfile(profile, name)).toBe(false);
      }
    }
    // The coordinator does not launch a CLI permission workflow, so even its
    // bridge-only control tool stays out of the direct-call allow-list.
    expect(isToolAllowedForProfile("global-orchestrator", "approval_prompt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callOpenBrowserPane
// ---------------------------------------------------------------------------

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return impl as typeof fetch;
}

describe("callWaitForCondition", () => {
  const args = { baseUrl: "http://x", sessionKey: "s" };

  test("attesa accettata: dice all'agent che il task riparte da solo", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ dispatchState: "waiting", dispatchDeferredUntil: "2026-08-12T10:00:00.000Z" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const out = await callWaitForCondition(args, { task_id: "t1", reason: "la CI sta girando" }, fetchImpl);
    expect(out).toContain("re-dispatched automatically");
    expect(out).toContain("2026-08-12T10:00:00.000Z");
  });

  test("attesa RIFIUTATA: non promette un rientro in coda che non ci sarà", async () => {
    // Il server ha parcheggiato il task (serie di attese oltre il tetto). La
    // riga di prima diceva «it will be re-dispatched automatically» comunque, e
    // un agente che la legge chiude il turno convinto di dover solo aspettare:
    // il task resta in backlog e nessuno lo sa.
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ dispatchState: "waited_out", dispatchDeferredUntil: null }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const out = await callWaitForCondition(args, { task_id: "t1", reason: "la CI sta girando" }, fetchImpl);
    expect(out).toContain("PARKED");
    expect(out).toContain("NOT be re-dispatched");
    expect(out).toContain("do not call wait_for_condition again");
    expect(out).not.toContain("It will be re-dispatched automatically");
  });
});

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
    expect(result).toEqual({ url: "https://example.com/final", title: "Example Domain", visible: true });
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
    // `visible` assente ⇒ true: un server più vecchio del flag non deve far
    // dire all'agente «non si vede» di un pannello che magari si vede benissimo.
    expect(result).toEqual({ url: "https://example.com/foo", title: "", visible: true });
  });

  test("forwards a server-side warning (foreign-port / no-response check, task f9cf765e)", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(
        JSON.stringify({ url: "http://localhost:3333/", title: "", visible: true, warning: "⚠ Port 3333 is served by another project" }),
        { status: 200 },
      ),
    );
    const result = await callOpenBrowserPane(
      { baseUrl: "http://x", sessionKey: "s" },
      { url: "http://localhost:3333/" },
      fetchImpl,
    );
    expect(result.warning).toBe("⚠ Port 3333 is served by another project");
  });

  test("no warning field when the server has nothing to say", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ url: "https://example.com/", title: "" }), { status: 200 }),
    );
    const result = await callOpenBrowserPane(
      { baseUrl: "http://x", sessionKey: "s" },
      { url: "https://example.com/" },
      fetchImpl,
    );
    expect(result.warning).toBeUndefined();
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
// Multi-tab tools: list-tabs + focus-pane
// ---------------------------------------------------------------------------

describe("callListBrowserTabs", () => {
  test("POSTs to the session-keyed list-tabs endpoint and returns the tabs JSON", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const tabs = [
      { contextId: "t1", url: "https://a", title: "A", label: "Roadmap", kind: "topic", isOwn: true },
    ];
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ tabs }), { status: 200 });
    });
    const text = await callListBrowserTabs(
      { baseUrl: "http://localhost:3333", sessionKey: "topic:abc" },
      {},
      fetchImpl,
    );
    expect(seen.url).toBe("http://localhost:3333/api/sessions/topic%3Aabc/browser/list-tabs");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(text)).toEqual(tabs);
  });

  test("returns [] when the server omits tabs", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    const text = await callListBrowserTabs({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(JSON.parse(text)).toEqual([]);
  });
});

describe("callFocusBrowserTab", () => {
  test("POSTs an explicit contextId to the focus-pane endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ ok: true, contextId: "ctx-9" }), { status: 200 });
    });
    const text = await callFocusBrowserTab(
      { baseUrl: "http://x", sessionKey: "s" },
      { contextId: "ctx-9" },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/s/browser/focus-pane");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe(JSON.stringify({ contextId: "ctx-9" }));
    expect(text).toContain("ctx-9");
  });

  test("omits contextId from the body when none is given (focus own pane)", async () => {
    let seenBody: string | undefined;
    const fetchImpl = stubFetch(async (_url, init) => {
      seenBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true, contextId: "own" }), { status: 200 });
    });
    await callFocusBrowserTab({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(seenBody).toBe(JSON.stringify({}));
  });
});

// ---------------------------------------------------------------------------
// callSendChatMessage / callReadChatMessages
// ---------------------------------------------------------------------------

/** Build a fake SSE Response streaming OpenAI-shaped content deltas. */
function sseResponse(deltas: string[]): Response {
  const lines = deltas
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
    .join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines + "data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("callSendChatMessage", () => {
  const A = { baseUrl: "http://x", sessionKey: "topic:mine" };

  test("resolves the target topic's sessionKey, POSTs /api/chat, returns the concatenated reply", async () => {
    let chatBody = "";
    const fetchImpl = stubFetch(async (url, init) => {
      const u = String(url);
      // One topic, whole: the list (`GET /api/topics`) is the live half only,
      // and a closed chat must still be reachable by id.
      if (u.endsWith("/api/topics/t1")) {
        return new Response(JSON.stringify({ topic: { sessionKey: "topic:target", name: "Target", archived: true } }), { status: 200 });
      }
      if (u.endsWith("/api/chat")) {
        chatBody = String(init?.body ?? "");
        return sseResponse(["PONG", "-", "ok"]);
      }
      throw new Error(`unexpected url ${u}`);
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "ping" }, fetchImpl);
    expect(out).toBe("PONG-ok");
    const parsed = JSON.parse(chatBody);
    expect(parsed.sessionKey).toBe("topic:target");
    expect(parsed.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  test("refuses to message your own session (self-loop guard)", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ topic: { sessionKey: "topic:mine", name: "Me" } }), { status: 200 }),
    );
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "hi" }, fetchImpl)).rejects.toThrow(/own session/);
  });

  test("throws when the target topic is unknown", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ error: "Topic not found" }), { status: 404 }));
    await expect(callSendChatMessage(A, { topic_id: "nope", message: "hi" }, fetchImpl)).rejects.toThrow(/not found/);
  });

  test("empty reply (tool-only turn) returns an inspect hint, not an error", async () => {
    const fetchImpl = stubFetch(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/topics/t1")) return new Response(JSON.stringify({ topic: { sessionKey: "topic:target", name: "T" } }), { status: 200 });
      return sseResponse([]);
    });
    const out = await callSendChatMessage(A, { topic_id: "t1", message: "go" }, fetchImpl);
    expect(out).toMatch(/read_chat_messages/);
  });

  test("throws on missing topic_id / message", async () => {
    const noop = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(callSendChatMessage(A, { message: "hi" }, noop)).rejects.toThrow(/topic_id/);
    await expect(callSendChatMessage(A, { topic_id: "t1", message: "  " }, noop)).rejects.toThrow(/message/);
  });
});

describe("callReadChatMessages", () => {
  test("GETs the topic messages endpoint with a clamped limit and returns compact roles", async () => {
    let seenUrl = "";
    const fetchImpl = stubFetch(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ topicName: "T", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] }), { status: 200 });
    });
    const out = await callReadChatMessages({ baseUrl: "http://x", sessionKey: "s" }, { topic_id: "t1", limit: 999 }, fetchImpl);
    expect(seenUrl).toContain("/api/topics/t1/messages?limit=200"); // clamped to 200
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(2);
    expect(parsed.messages[1]).toEqual({ role: "assistant", content: "yo" });
  });

  test("throws on missing topic_id", async () => {
    const noop = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(callReadChatMessages({ baseUrl: "http://x", sessionKey: "s" }, {}, noop)).rejects.toThrow(/topic_id/);
  });
});

// ---------------------------------------------------------------------------
// callResolveTab — GET /api/tabs/resolve
// ---------------------------------------------------------------------------

describe("callResolveTab", () => {
  const A = { baseUrl: "http://x", sessionKey: "s" };

  test("GETs the resolve endpoint with the ref encoded, and returns the body verbatim", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const resolved = {
      kind: "chat",
      key: "topic-1",
      title: "Rifattorizzare il resolver",
      state: "open",
      surface: "project:/Users/me/Projects/topics-app",
      pointers: { topicId: "topic-1", projectPath: "/Users/me/Projects/topics-app" },
      next: { tool: "read_chat_messages", args: { topic_id: "topic-1" } },
    };
    const fetchImpl = stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenMethod = String(init?.method ?? "GET");
      return new Response(JSON.stringify(resolved), { status: 200 });
    });

    const out = await callResolveTab(A, { ref: "https://127.0.0.1:3333/tab/chat/topic-1?x=1" }, fetchImpl);
    expect(seenMethod).toBe("GET");
    // Il ref intero (query compresa) deve viaggiare come UN parametro: se non lo
    // si encoda, la sua '?'/'&' verrebbero lette come query della NOSTRA rotta.
    expect(seenUrl).toBe(
      "http://x/api/tabs/resolve?ref=https%3A%2F%2F127.0.0.1%3A3333%2Ftab%2Fchat%2Ftopic-1%3Fx%3D1",
    );
    // Il corpo si rigira tale e quale: `next` è il valore del tool.
    expect(JSON.parse(out)).toEqual(resolved);
  });

  test("throws on a missing / blank ref without calling the server", async () => {
    let called = false;
    const fetchImpl = stubFetch(async () => { called = true; return new Response("{}", { status: 200 }); });
    await expect(callResolveTab(A, {}, fetchImpl)).rejects.toThrow(/ref.*required/i);
    await expect(callResolveTab(A, { ref: "   " }, fetchImpl)).rejects.toThrow(/ref.*required/i);
    expect(called).toBe(false);
  });

  test("surfaces the server's 400 message when the ref is not a permalink", async () => {
    // 400, non 404: la rotta non sta dicendo «la tab non esiste» ma «questo non
    // è un link a una tab» — ed è quel messaggio che deve arrivare al modello.
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "ref is not a tab permalink" }), { status: 400 }),
    );
    await expect(callResolveTab(A, { ref: "https://example.com/whatever" }, fetchImpl))
      .rejects.toThrow(/ref is not a tab permalink/);
  });

  test("throws when the server answers something that is not a resolved tab", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(callResolveTab(A, { ref: "/tab/panel/board" }, fetchImpl))
      .rejects.toThrow(/did not return a resolved tab/);
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

  test("tools/list → returns the ordinary Phase-1 tool set without global-only authority", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ARGS,
    );
    const tools = (resp!.result as any).tools as Array<{ name: string; inputSchema: any }>;
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "open_browser_pane",
      "close_browser_pane",
      "browser_list_tabs",
      "browser_focus_tab",
      "import_chrome",
      // Ref-based browser tools — projected from browser-tool-spec.ts.
      "browser_observe",
      "browser_act",
      "browser_extract",
      "browser_get_text",
      "browser_screenshot",
      "browser_read_screen",
      "browser_console",
      "browser_network",
      "browser_eval",
      "browser_save_state",
      "browser_load_state",
      "browser_status",
      "browser_upload",
      "run_script",
      "list_processes",
      "read_process_output",
      "wait_for_process",
      "stop_process",
      "list_tasks",
      "create_task",
      "get_task",
      "get_goal",
      "close_goal",
      "set_goal",
      "update_goal_steps",
      "update_task",
      "wait_for_condition",
      "label_task",
      "comment_task",
      "ask_user_question",
      // Il canale di permesso: pubblicato sempre. Lo designa
      // `--permission-prompt-tool`, e la CLI lo toglie da sé dall'elenco che
      // il modello vede — quindi non costa contesto, e non esiste una
      // combinazione in cui la CLI lo cerchi e il bridge non ce l'abbia.
      "approval_prompt",
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
      "send_chat_message",
      "read_chat_messages",
      "resolve_tab",
    ]);
    const browser = tools.find((t) => t.name === "open_browser_pane")!;
    expect(browser.inputSchema.required).toEqual(["url"]);
    expect(browser.inputSchema.properties.url.type).toBe("string");
    expect(tools.find((t) => t.name === "run_script")!.inputSchema.required).toEqual(["script"]);
    expect(tools.find((t) => t.name === "update_task")!.inputSchema.required).toEqual(["task_id"]);
    expect(tools.find((t) => t.name === "create_task")!.inputSchema.required).toEqual(["text"]);
    expect(tools.find((t) => t.name === "comment_task")!.inputSchema.required).toEqual(["task_id", "content"]);
    expect(tools.find((t) => t.name === "resolve_tab")!.inputSchema.required).toEqual(["ref"]);

    // Il pannello domande: due dichiarazioni che sembrano dettagli e non lo sono.
    //
    // `readOnlyHint` è la riga che la CLI guarda in `--permission-mode plan`
    // per decidere se un tool MCP può girare: senza, la chat impostata su
    // «chiedi prima» era l'unica che non poteva chiedere («Cannot call
    // mcp__topics__ask_user_question while in plan mode», topic:ed2070df).
    // `recommended` è il modo in cui il modello dice quale strada consiglia:
    // se sparisce dallo schema il chip non comparirà mai, e nessun test se ne
    // accorgerebbe guardando solo i nomi dei tool.
    const ask = tools.find((t) => t.name === "ask_user_question")!;
    expect((ask as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint).toBe(true);
    const option = ask.inputSchema.properties.questions.items.properties.options.items;
    expect(option.properties.recommended?.type).toBe("boolean");
    expect(option.required).toEqual(["label"]);
  });

  // IL CANCELLO DI `readOnlyHint` (task 46480579).
  //
  // In `--permission-mode plan` — cioè in ogni chat impostata su «ask» — la CLI
  // lascia passare SOLO i tool che si dichiarano di sola lettura. Finché la
  // dichiarazione stava sul solo pannello domande, una chat in «ask» non poteva
  // nemmeno GUARDARE la board: `list_tasks` tornava «Cannot call
  // mcp__topics__list_tasks while in plan mode».
  //
  // Il test non si limita a contare le annotazioni presenti: pretende che
  // l'unione delle due liste qui sotto sia ESATTAMENTE l'elenco dei tool
  // pubblicati. Un tool nuovo non può quindi restare senza classificazione —
  // finisce rosso finché qualcuno non decide da che parte sta. È l'unico modo
  // di avere un cancello che fallisce anche su ciò che ancora non esiste.
  test("ogni tool dichiara se è di sola lettura, e nessuno resta senza classificazione", async () => {
    const SOLA_LETTURA = [
      // Leggono la pagina viva, senza toccarla.
      "browser_observe", "browser_extract", "browser_get_text", "browser_screenshot",
      "browser_read_screen", "browser_console", "browser_network", "browser_status",
      // Leggono lo stato di Topics.
      "browser_list_tabs", "list_processes", "read_process_output",
      // Aspettare la fine di un processo non lo tocca: è una lettura che dura.
      "wait_for_process",
      "list_tasks", "get_task", "get_goal", "read_agent", "list_agents",
      "list_global_tasks", "get_global_task",
      "read_chat_messages", "resolve_tab",
      // Chiedere a una persona non cambia niente: è la lettura più pura che ci sia.
      "ask_user_question", "approval_prompt",
    ].sort();
    const MODIFICANO = [
      // Aprono, chiudono, spostano o scrivono qualcosa — pane, processi, board,
      // topic, progetti, chat. `browser_focus_tab` è qui di proposito: portare
      // una tab in primo piano cambia ciò che la persona ha davanti.
      "open_browser_pane", "close_browser_pane", "browser_focus_tab", "import_chrome",
      "browser_act", "browser_eval", "browser_save_state", "browser_load_state",
      "browser_upload",
      "run_script", "stop_process",
      "create_task", "update_task", "close_goal", "set_goal", "update_goal_steps",
      "comment_task", "label_task", "wait_for_condition",
      "create_global_task", "update_global_task", "comment_global_task",
      "move_session_to_project", "spawn_agent", "send_to_agent", "stop_agent",
      "switch_topic", "new_topic", "create_project", "open_project",
      "send_chat_message",
    ].sort();

    const resp = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/list" }, ARGS);
    const ordinaryTools = (resp!.result as any).tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    const globalResp = await handleMessage(
      { jsonrpc: "2.0", id: 10, method: "tools/list" },
      { ...ARGS, profile: "global-orchestrator" },
    );
    const globalTools = (globalResp!.result as any).tools as typeof ordinaryTools;
    const tools = [...ordinaryTools, ...globalTools];

    // 1. Nessun tool sfugge alla classificazione, in nessuna delle due direzioni.
    expect([...SOLA_LETTURA, ...MODIFICANO].sort()).toEqual([...tools.map((t) => t.name)].sort());

    // 2. Ogni tool porta un `readOnlyHint` ESPLICITO: `undefined` non è «false»,
    //    è una riga che nessuno ha scritto, e la CLI la tratta come un no.
    for (const t of tools) {
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
    }

    // 3. E il valore corrisponde alla lista, tool per tool.
    for (const name of SOLA_LETTURA) {
      expect(tools.find((t) => t.name === name)!.annotations!.readOnlyHint).toBe(true);
    }
    for (const name of MODIFICANO) {
      expect(tools.find((t) => t.name === name)!.annotations!.readOnlyHint).toBe(false);
    }
  });

  test("tools/list under --profile=dispatch drops the orchestration/nav tools", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { ...ARGS, profile: "dispatch" },
    );
    const names = ((resp!.result as any).tools as Array<{ name: string }>).map((t) => t.name);
    // Excluded: cross-topic chat, topic/tab nav, projects, chrome import.
    for (const gone of [
      "list_agents",
      "send_chat_message", "read_chat_messages", "new_topic", "switch_topic",
      "import_chrome", "move_session_to_project", "create_project", "open_project",
    ]) {
      expect(names).not.toContain(gone);
    }
    // Il FAN-OUT resta, ed e' il modello del coordinatore: la sessione del task
    // decide e delega, il lavoro gira nelle figlie. Non e' fuori governo — il
    // tetto le conta (agent-census.ts), il costo si contabilizza sul task
    // (dispatch-usage.ts), profondita' 1, e muoiono col padre.
    for (const kept of ["spawn_agent", "send_to_agent", "read_agent", "stop_agent"]) {
      expect(names).toContain(kept);
    }
    // Kept: the task tools, processes, and every browser_* verification tool.
    // `resolve_tab` stays ON PURPOSE: a dispatched board agent also gets links
    // pasted by the human in the task thread, and must be able to say what they
    // point at instead of guessing.
    for (const kept of ["list_tasks", "create_task", "update_task", "comment_task", "get_task", "run_script", "browser_observe", "browser_read_screen", "open_browser_pane", "resolve_tab"]) {
      expect(names).toContain(kept);
    }
  });

  test("tools/call refuses a profile-excluded tool (defense in depth)", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_agents", arguments: {} } },
      { ...ARGS, profile: "dispatch" },
    );
    expect((resp!.error as any)?.code).toBe(-32601);
    expect((resp!.error as any)?.message).toMatch(/not available in this session profile/);
  });

  test("every bridged browser_* tool advertises an optional contextId arg", () => {
    // The "manage any tab" seam: contextId is injected into every MCP browser
    // tool by mcpBrowserTools(), and must never be required (own-pane is default).
    const { mcpBrowserTools } = require("../browser-tool-spec");
    const bridged = mcpBrowserTools() as Array<{ name: string; inputSchema: any }>;
    for (const t of bridged) {
      expect(t.inputSchema.properties.contextId?.type).toBe("string");
      expect(t.inputSchema.required ?? []).not.toContain("contextId");
    }
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

  test("open_browser_pane: i due esiti si LEGGONO diversi (visibile vs contesto invisibile)", async () => {
    // Finché il messaggio era lo stesso, «pannello aperto» e «contesto vivo che
    // nessuno vede» erano indistinguibili da fuori: l'agente diceva all'umano
    // «l'ho aperta» mentre sullo schermo non compariva niente (11/08/2026).
    const orig = globalThis.fetch;
    const call = async (visible: boolean) => {
      (globalThis as any).fetch = stubFetch(async () =>
        new Response(JSON.stringify({ url: "https://example.com/", title: "T", visible }), { status: 200 }),
      );
      const resp = await handleMessage(
        { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "open_browser_pane", arguments: { url: "https://example.com/" } } },
        ARGS,
      );
      return (resp!.result as any).content[0].text as string;
    };
    try {
      expect(await call(true)).toContain("Opened browser pane at https://example.com/");
      const invisibile = await call(false);
      expect(invisibile).toContain("NO visible pane");
      expect(invisibile).toContain("browser_focus_tab");
      expect(invisibile).not.toContain("Opened browser pane");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("open_browser_pane: a foreign-port warning LEADS the text, it does not trail it (task f9cf765e)", async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = stubFetch(async () =>
      new Response(
        JSON.stringify({
          url: "http://localhost:3333/",
          title: "",
          visible: true,
          warning: "⚠ Port 3333 is served by pid 222 (node) from another project (/Users/x/Projects/darkroom)",
        }),
        { status: 200 },
      ),
    );
    try {
      const resp = await handleMessage(
        { jsonrpc: "2.0", id: 78, method: "tools/call", params: { name: "open_browser_pane", arguments: { url: "http://localhost:3333/" } } },
        ARGS,
      );
      const text = (resp!.result as any).content[0].text as string;
      expect(text.startsWith("⚠ Port 3333")).toBe(true);
      expect(text).toContain("darkroom");
      expect(text).toContain("Opened browser pane at http://localhost:3333/");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("tools/call inoltra il progressToken del client fino alle gambe dell'ask", async () => {
    // Il ponte fra le due metà del fix: il client dice «tienimi aggiornato»
    // mettendo un `_meta.progressToken` sulla chiamata, e ogni gamba pendente
    // deve tornargli indietro come `notifications/progress` — senza id, perché
    // nessuno la sta aspettando. Senza questo giro, il pannello muore al
    // timeout del client mentre l'umano sta ancora leggendo.
    const orig = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = stubFetch(async () => {
      calls++;
      if (calls < 3) return new Response(JSON.stringify({ pending: true }), { status: 200 });
      return new Response(JSON.stringify({ answers: { Q: "A" } }), { status: 200 });
    });
    const emitted: any[] = [];
    try {
      const resp = await handleMessage(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "ask_user_question",
            arguments: { questions: [{ question: "Q", options: [{ label: "A" }] }] },
            _meta: { progressToken: "tok-1" },
          },
        },
        ARGS,
        (m) => emitted.push(m),
      );
      expect((resp!.result as any).isError).toBeUndefined();
      expect(emitted).toHaveLength(2);
      expect(emitted[0].method).toBe("notifications/progress");
      expect(emitted[0].params.progressToken).toBe("tok-1");
      expect(emitted[0].params.progress).toBe(1);
      expect(emitted[1].params.progress).toBe(2);
      // Nessun `id`: è una notifica, non una risposta a qualcosa.
      expect(emitted[0].id).toBeUndefined();
      // Nessun `total`: non siamo "al 40%" di un umano che decide.
      expect(emitted[0].params.total).toBeUndefined();
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("tools/call routes resolve_tab through the registry", async () => {
    const orig = globalThis.fetch;
    let seenUrl = "";
    (globalThis as any).fetch = stubFetch(async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({
        kind: "task", key: "t-42", title: "Landa il resolver", state: "closed",
        surface: "app", pointers: { taskId: "t-42" },
        next: { tool: "get_task", args: { task_id: "t-42" } },
      }), { status: 200 });
    });
    try {
      const resp = await handleMessage(
        { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "resolve_tab", arguments: { ref: "/task/t-42" } } },
        ARGS,
      );
      const result = resp!.result as any;
      expect(result.isError).toBeUndefined();
      expect(seenUrl).toBe("http://localhost:3333/api/tabs/resolve?ref=%2Ftask%2Ft-42");
      expect(JSON.parse(result.content[0].text).next).toEqual({ tool: "get_task", args: { task_id: "t-42" } });
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("senza progressToken la chiamata funziona lo stesso e non emette niente", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    (globalThis as any).fetch = stubFetch(async () => {
      calls++;
      if (calls < 2) return new Response(JSON.stringify({ pending: true }), { status: 200 });
      return new Response(JSON.stringify({ answers: { Q: "A" } }), { status: 200 });
    });
    const emitted: any[] = [];
    try {
      const resp = await handleMessage(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: { name: "ask_user_question", arguments: { questions: [{ question: "Q", options: [{ label: "A" }] }] } },
        },
        ARGS,
        (m) => emitted.push(m),
      );
      expect((resp!.result as any).isError).toBeUndefined();
      expect(emitted).toHaveLength(0);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("resolve_tab stays callable under --profile=dispatch", async () => {
    // Non è in DISPATCH_EXCLUDED_TOOLS di proposito: anche un agente di board
    // riceve link incollati dall'umano. Qui si verifica il ramo tools/call, che
    // ha il suo gate separato da tools/list.
    const orig = globalThis.fetch;
    (globalThis as any).fetch = stubFetch(async () =>
      new Response(JSON.stringify({
        kind: "panel", key: "board", title: "Board", state: "open", surface: "app",
        pointers: {}, next: { tool: "list_tasks", args: {} },
      }), { status: 200 }),
    );
    try {
      const resp = await handleMessage(
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "resolve_tab", arguments: { ref: "/tab/panel/board" } } },
        { ...ARGS, profile: "dispatch" },
      );
      expect(resp!.error).toBeUndefined();
      expect((resp!.result as any).isError).toBeUndefined();
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("tools/call forwards a browser tool's contextId override in the request body", async () => {
    // The bridge forwards toolArgs verbatim, so a contextId targeting another tab
    // rides in the POST body to /browser/get-text (the REST route extracts it).
    const orig = globalThis.fetch;
    let seenUrl = "";
    let seenBody = "";
    (globalThis as any).fetch = stubFetch(async (url, init) => {
      seenUrl = String(url);
      seenBody = (init?.body as string) ?? "";
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    });
    try {
      const resp = await handleMessage(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "browser_get_text", arguments: { contextId: "other-tab", max: 500 } },
        },
        ARGS,
      );
      expect((resp!.result as any).isError).toBeUndefined();
      expect(seenUrl).toContain("/api/sessions/s/browser/get-text");
      expect(JSON.parse(seenBody)).toEqual({ contextId: "other-tab", max: 500 });
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

describe("callWaitForProcess", () => {
  test("porta until/timeout/offset nella query e legge l'esito", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({
        output: "ready in 300ms", offset: 12, status: "running",
        reason: "match", waitedMs: 4200,
      }), { status: 200 });
    });
    const text = await callWaitForProcess(
      { baseUrl: "http://x", sessionKey: "s" },
      { process_id: "p1", until: "ready", timeout_ms: 30000, offset: 7 },
      fetchImpl,
    );
    expect(seen.url).toContain("/api/sessions/s/scripts/p1/wait?");
    expect(seen.url).toContain("offset=7");
    expect(seen.url).toContain("timeout_ms=30000");
    expect(seen.url).toContain("until=ready");
    expect(text).toContain("ready in 300ms");
    expect(text).toContain("reason=match");
    expect(text).toContain("matched after 4s");
  });

  test("una scadenza si legge come «ancora vivo», non come un guasto", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ output: "", offset: 40, status: "running", reason: "timeout", waitedMs: 120000 }), { status: 200 }),
    );
    const text = await callWaitForProcess({ baseUrl: "http://x", sessionKey: "s" }, { process_id: "p1" }, fetchImpl);
    expect(text).toContain("STILL RUNNING");
    expect(text).toContain("not an error");
    expect(text).toContain("offset=40");
  });

  test("l'uscita porta stato e codice", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ output: "1 failing", offset: 3, status: "error", exitCode: 1, reason: "exit", waitedMs: 9000 }), { status: 200 }),
    );
    const text = await callWaitForProcess({ baseUrl: "http://x", sessionKey: "s" }, { process_id: "p1" }, fetchImpl);
    expect(text).toContain("finished after 9s");
    expect(text).toContain("status=error");
    expect(text).toContain("exit=1");
  });

  test("throws when process_id missing", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callWaitForProcess({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
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

  test("uno STEP si distingue da una card: porta il padre in coda alla riga", async () => {
    // La rotta della sessione non taglia le radici, quindi i sottotask erano
    // gia' in lista — ma identici a una card. Un agente che rilegge la propria
    // checklist dopo un cambio di sessione non poteva dire quali righe fossero
    // i suoi passi, e le leggeva come lavoro di qualcun altro.
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ tasks: [
      { status: "in_progress", text: "La card", id: "t1", projectId: "p1", parentTaskId: null },
      { status: "todo", text: "Uno step", id: "t2", projectId: "p1", parentTaskId: "t1" },
    ] }), { status: 200 }));
    const text = await callListTasks({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl);
    expect(text).toContain("[todo] Uno step (id=t2 project=p1 step of=t1)");
    expect(text, "la card non finge di essere lo step di nessuno").toContain("[in_progress] La card (id=t1 project=p1)");
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

  test("preview_image arriva al server invece di essere buttato via", async () => {
    // Il protocollo (docs/board-protocol.md) dice `update_task(previewImage=…)` e
    // l'envelope lo porta a ogni agente, ma il campo non era nello schema: il
    // valore veniva scartato in SILENZIO. Tre consegne di fila hanno scritto
    // «anteprima allegata» con la card vuota — sembravano bugie, erano agenti
    // che seguivano il protocollo mentre lo strumento perdeva il valore.
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t1", status: "review" }), { status: 200 });
    });
    await callUpdateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", status: "review", preview_image: "/Users/x/.topics/media/prova.webm" },
      fetchImpl,
    );
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      status: "review",
      previewImage: "/Users/x/.topics/media/prova.webm",
      // La gamba viaggia con la consegna: e' quanto questa richiesta e' disposta
      // ad aspettare i check prima di rimettersi in fila.
      legMs: CHECKS_LEG_MS,
    });
  });

  test("anche `previewImage` in camelCase arriva: e' il nome che insegnano i prompt", async () => {
    // Il doctor della board ha trovato questo mentre la correzione era fresca:
    // «il protocollo insegna previewImage, lo schema dichiara preview_image».
    // Con un solo nome accettato, un agente che obbedisce al testo ricevuto
    // perde l'anteprima in silenzio — lo stesso guasto, riaperto dal lato del nome.
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t1", status: "review" }), { status: 200 });
    });
    await callUpdateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", previewImage: "/Users/x/.topics/media/camel.png" } as never,
      fetchImpl,
    );
    expect(JSON.parse(String(seen.init?.body))).toEqual({ previewImage: "/Users/x/.topics/media/camel.png" });
  });

  test("preview_image da solo basta: non serve accompagnarlo a uno stato", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t1", status: "in_progress" }), { status: 200 });
    });
    await callUpdateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", preview_image: "/Users/x/.topics/media/p.png" },
      fetchImpl,
    );
    expect(JSON.parse(String(seen.init?.body))).toEqual({ previewImage: "/Users/x/.topics/media/p.png" });
  });

  /**
   * I CHECK PRE-REVIEW DURANO MINUTI, la richiesta no: il server risponde 202
   * «stanno girando» e chi ricicla è questo ciclo. Prima il gate girava dentro
   * la PATCH e il socket moriva a 255s (tetto di Bun), lasciando la card a
   * «running» per sempre.
   */
  test("202 pending: richiama finche' c'e' un esito, e lo dice a ogni gamba", async () => {
    let chiamate = 0;
    const fetchImpl = stubFetch(async () => {
      chiamate += 1;
      return chiamate < 3
        ? new Response(JSON.stringify({ pending: true, code: "review_checks_running" }), { status: 202 })
        : new Response(JSON.stringify({ id: "t1", status: "review" }), { status: 200 });
    });
    const gambe: number[] = [];
    const text = await callUpdateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", status: "review" },
      fetchImpl,
      { onProgress: (leg) => gambe.push(leg) },
    );
    expect(text).toBe("task t1 → review");
    expect(chiamate).toBe(3);
    expect(gambe).toEqual([1, 2]); // silenzio = chiamata piantata, per il client MCP
  });

  test("un rosso non si ricicla: il 409 con l'output esce subito", async () => {
    let chiamate = 0;
    const fetchImpl = stubFetch(async () => {
      chiamate += 1;
      return chiamate === 1
        ? new Response(JSON.stringify({ pending: true }), { status: 202 })
        : new Response(JSON.stringify({ error: "✗ `test:unit` (2m 1s)\nassertion failed", code: "review_needs_green_checks" }), { status: 409 });
    });
    await expect(
      callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", status: "review" }, fetchImpl),
    ).rejects.toThrow(/assertion failed/);
    expect(chiamate).toBe(2);
  });

  test("un server che dice 'pending' per sempre non fa girare a vuoto per sempre", async () => {
    let chiamate = 0;
    const fetchImpl = stubFetch(async () => {
      chiamate += 1;
      return new Response(JSON.stringify({ pending: true }), { status: 202 });
    });
    await expect(
      callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", status: "review" }, fetchImpl, { maxLegs: 4, legMs: 1 }),
    ).rejects.toThrow(/check pre-review/i);
    expect(chiamate).toBe(4);
  });

  test("un buco di rete DENTRO l'attesa non butta via dieci minuti di check", async () => {
    // Un hot-reload del server mentre i comandi girano: la gamba muore, la
    // successiva riaggancia. Alla PRIMA chiamata, invece, un guasto resta un
    // guasto: e' il comportamento di sempre e non si tocca.
    let chiamate = 0;
    const fetchImpl = stubFetch(async () => {
      chiamate += 1;
      if (chiamate === 1) return new Response(JSON.stringify({ pending: true }), { status: 202 });
      if (chiamate === 2) throw new Error("fetch failed");
      return new Response(JSON.stringify({ id: "t1", status: "review" }), { status: 200 });
    });
    const text = await callUpdateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", status: "review" },
      fetchImpl,
      { backoffMs: [1] },
    );
    expect(text).toBe("task t1 → review");
    expect(chiamate).toBe(3);

    const subito = stubFetch(async () => { throw new Error("fetch failed"); });
    await expect(
      callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", status: "review" }, subito, { backoffMs: [1] }),
    ).rejects.toThrow(/fetch failed/);
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

  test("forwards output_url — including empty string (clears the output)", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t1", status: "in_progress" }), { status: 200 });
    });
    await callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", output_url: "http://localhost:5173" }, fetchImpl);
    expect(seen.init?.body).toBe(JSON.stringify({ output_url: "http://localhost:5173" }));
    await callUpdateTask({ baseUrl: "http://x", sessionKey: "s" }, { task_id: "t1", output_url: "" }, fetchImpl);
    expect(seen.init?.body).toBe(JSON.stringify({ output_url: "" }));
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

  // Il cancello sui doppioni (409) vive sulla rotta /api/sessions/:key/tasks,
  // che è ESATTAMENTE la porta di questo tool. Se la scappatoia non passa di
  // qui, l'agente che incappa nel falso positivo noto non ha modo di
  // scavalcare: riscrive il titolo finché passa, cioè il guasto che il
  // cancello doveva impedire.
  test("allow_duplicate arriva fino al corpo della richiesta", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t9", status: "backlog" }), { status: 201 });
    });
    await callCreateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { text: "store: UserMemoryStore.update() + unit test", allow_duplicate: true },
      fetchImpl,
    );
    expect(JSON.parse(String(seen.init?.body)).allow_duplicate).toBe(true);
  });

  test("senza allow_duplicate il corpo resta pulito", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "t9", status: "backlog" }), { status: 201 });
    });
    await callCreateTask({ baseUrl: "http://x", sessionKey: "s" }, { text: "una card nuova" }, fetchImpl);
    expect(JSON.parse(String(seen.init?.body))).toEqual({ text: "una card nuova" });
  });

  test("il 409 dice all'agente QUALE card esiste già, con l'id", async () => {
    // Corpo esattamente com'è oggi sulla rotta: l'id sta SOLO in `duplicates[]`,
    // mai dentro `error`. Il messaggio è l'unica cosa che l'agente vede, quindi
    // se `duplicates[]` si perde per strada gli si sta dicendo «commenta quella
    // card» senza dargli di quale card si tratti.
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({
      error: "una card lo dice già: «store: UserMemoryStore.update() + test». Commenta quella, oppure rimanda con allow_duplicate: true.",
      code: "duplicate",
      duplicates: [{ id: "t0abc123", text: "store: UserMemoryStore.update() + test", score: 0.91 }],
    }), { status: 409 }));
    const err = await callCreateTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { text: "store: UserMemoryStore.update() + unit test" },
      fetchImpl,
    ).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("t0abc123");
    expect(err!.message).toContain("allow_duplicate");
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

describe("callGetGoal", () => {
  test("renders the active goal with its steps, addressed by session key", async () => {
    const seen: { url?: string } = {};
    const fetchImpl = stubFetch(async (url) => {
      seen.url = String(url);
      return new Response(JSON.stringify({
        goal: { id: "g1", content: "Mergia e chiudi tutto", status: "active", steps: [
          { content: "landare le review", status: "completed" },
          { content: "spingere main", status: "in_progress" },
          { content: "chiudere il goal", status: "pending" },
        ] },
        history: [],
      }), { status: 200 });
    });
    const text = await callGetGoal({ baseUrl: "http://x", sessionKey: "topic:abc" }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/goal");
    expect(text).toContain("Active goal (id=g1): Mergia e chiudi tutto");
    expect(text).toContain("[x] landare le review");
    expect(text).toContain("[~] spingere main");
    expect(text).toContain("[ ] chiudere il goal");
  });

  test("no active goal: says so, and whether there were past ones", async () => {
    const none = stubFetch(async () => new Response(JSON.stringify({ goal: null, history: [] }), { status: 200 }));
    expect(await callGetGoal({ baseUrl: "http://x", sessionKey: "s" }, none)).toBe("No goal declared on this topic.");
    const past = stubFetch(async () => new Response(JSON.stringify({ goal: null, history: [{ id: "g0", content: "x", status: "achieved" }] }), { status: 200 }));
    expect(await callGetGoal({ baseUrl: "http://x", sessionKey: "s" }, past)).toContain("1 past goal, all closed");
  });
});

describe("callCloseGoal", () => {
  test("DELETEs the session's goal with the status, and echoes the summary", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url); seen.init = init;
      return new Response(JSON.stringify({ goal: { id: "g1", content: "Mergia tutto", status: "achieved" } }), { status: 200 });
    });
    const text = await callCloseGoal(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { status: "achieved", summary: "10 card landate, main spinto." },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/goal");
    expect(seen.init?.method).toBe("DELETE");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ status: "achieved" });
    expect(text).toContain("closed as achieved");
    expect(text).toContain("10 card landate");
  });

  test("refuses a status that is neither achieved nor abandoned, and a missing summary", async () => {
    const never = stubFetch(async () => { throw new Error("must not be called"); });
    await expect(callCloseGoal({ baseUrl: "http://x", sessionKey: "s" }, { status: "done", summary: "x" }, never))
      .rejects.toThrow("'status' must be");
    await expect(callCloseGoal({ baseUrl: "http://x", sessionKey: "s" }, { status: "achieved" }, never))
      .rejects.toThrow("'summary'");
  });

  test("no active goal (404 from the server) surfaces as the server's sentence", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ error: "no active goal" }), { status: 404 }));
    await expect(callCloseGoal({ baseUrl: "http://x", sessionKey: "s" }, { status: "abandoned", summary: "n/a" }, fetchImpl))
      .rejects.toThrow("no active goal");
  });
});

/**
 * The agent declares its own objective and keeps the plan visible (card
 * d2a4a907). What matters at this level is the shape of the call and the
 * sentence that comes back to the model: the refusal on the person's goal is
 * decided by the route, and it is tested there.
 */
describe("callSetGoal", () => {
  test("PUTs the objective on the session's goal and answers with what to do next", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url); seen.init = init;
      return new Response(JSON.stringify({ goal: { id: "g1", content: "Portare a verde la suite", status: "active" } }), { status: 201 });
    });
    const text = await callSetGoal({ baseUrl: "http://x", sessionKey: "topic:abc" }, { content: "  Portare a verde la suite  " }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/goal");
    expect(seen.init?.method).toBe("PUT");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ content: "Portare a verde la suite" });
    expect(text).toContain("Goal set (id=g1): Portare a verde la suite");
    expect(text).toContain("update_goal_steps");
  });

  test("an empty objective never leaves, and the 409 reaches the model whole", async () => {
    const never = stubFetch(async () => { throw new Error("must not be called"); });
    await expect(callSetGoal({ baseUrl: "http://x", sessionKey: "s" }, { content: "   " }, never))
      .rejects.toThrow("'content'");
    // The refusal is the whole point: the model must READ why, or it retries.
    const refused = stubFetch(async () => new Response(JSON.stringify({
      error: "a goal declared by the person is active («Sistemare il login»): only they can replace it.",
    }), { status: 409 }));
    await expect(callSetGoal({ baseUrl: "http://x", sessionKey: "s" }, { content: "altro" }, refused))
      .rejects.toThrow("Sistemare il login");
  });
});

describe("callUpdateGoalSteps", () => {
  test("PUTs the WHOLE list and answers with the progress the person is looking at", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url); seen.init = init;
      return new Response(JSON.stringify({ goal: { id: "g1", content: "A", status: "active", steps: [
        { content: "leggere il router", status: "completed" },
        { content: "scrivere il test", status: "in_progress" },
        { content: "passare i cancelli", status: "pending" },
      ] } }), { status: 200 });
    });
    const text = await callUpdateGoalSteps({ baseUrl: "http://x", sessionKey: "topic:abc" }, {
      steps: [
        { content: "leggere il router", status: "completed" },
        { content: "scrivere il test", status: "in_progress" },
        { content: "passare i cancelli" },
      ],
    }, fetchImpl);
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/goal/steps");
    expect(seen.init?.method).toBe("PUT");
    // A step with no status is `pending`, not a refusal: the model sends the
    // list, the default is the obvious one.
    expect(JSON.parse(String(seen.init?.body)).steps[2]).toEqual({ content: "passare i cancelli", status: "pending" });
    expect(text).toBe("Plan updated: 1/3 done, now: scrivere il test.");
  });

  test("an empty list, or a status nobody knows, is refused before the call", async () => {
    const never = stubFetch(async () => { throw new Error("must not be called"); });
    await expect(callUpdateGoalSteps({ baseUrl: "http://x", sessionKey: "s" }, { steps: [] }, never))
      .rejects.toThrow("'steps'");
    await expect(callUpdateGoalSteps({ baseUrl: "http://x", sessionKey: "s" }, { steps: [{ content: "a", status: "doing" }] }, never))
      .rejects.toThrow("unknown status");
  });

  test("with no active goal the server's 404 reaches the model", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ error: "no active goal" }), { status: 404 }));
    await expect(callUpdateGoalSteps({ baseUrl: "http://x", sessionKey: "s" }, { steps: [{ content: "a" }] }, fetchImpl))
      .rejects.toThrow("no active goal");
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

  test("forwards question options as structured data (server composes the block)", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(JSON.stringify({ id: "c1" }), { status: 201 });
    });
    const text = await callCommentTask(
      { baseUrl: "http://x", sessionKey: "s" },
      { task_id: "t1", content: "Quale approccio?", options: ["A", "  ", "B", 42 as unknown as string] },
      fetchImpl,
    );
    // Non-string / blank entries dropped; the content stays the PLAIN question.
    expect(seen.init?.body).toBe(JSON.stringify({ content: "Quale approccio?", options: ["A", "B"] }));
    expect(text).toContain("2 quick-reply options");
  });
});

describe("callAskUserQuestion", () => {
  const questions = [
    {
      question: "Which auth method?",
      header: "Auth",
      options: [{ label: "OAuth" }, { label: "JWT" }],
    },
  ];

  test("POSTs the questions to the session ask-user endpoint and returns the answers JSON", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ answers: { Auth: "OAuth" } }), { status: 200 });
    });
    const text = await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "topic:abc" },
      { questions },
      fetchImpl,
    );
    expect(seen.url).toBe("http://x/api/sessions/topic%3Aabc/ask-user");
    expect(seen.init?.method).toBe("POST");
    // `legMs` travels with the questions: the bridge picks how long a leg may
    // block, because it's the bridge's socket that an idle timeout would kill.
    expect(JSON.parse(String(seen.init?.body))).toEqual({ questions, legMs: 25_000 });
    // The result the model reads mirrors the built-in AskUserQuestion shape.
    expect(JSON.parse(text)).toEqual({ answers: { Auth: "OAuth" } });
  });

  test("carries metadata through when the server returns it", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ answers: { Q: "A" }, metadata: { other: "free text" } }), { status: 200 }),
    );
    const text = await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "s" },
      { questions },
      fetchImpl,
    );
    expect(JSON.parse(text)).toEqual({ answers: { Q: "A" }, metadata: { other: "free text" } });
  });

  test("throws when questions is missing or empty", async () => {
    const fetchImpl = stubFetch(async () => new Response("{}", { status: 200 }));
    await expect(
      callAskUserQuestion({ baseUrl: "http://x", sessionKey: "s" }, {}, fetchImpl),
    ).rejects.toThrow(/questions.*required/i);
    await expect(
      callAskUserQuestion({ baseUrl: "http://x", sessionKey: "s" }, { questions: [] }, fetchImpl),
    ).rejects.toThrow(/questions.*required/i);
  });

  test("a cancelled ask surfaces as a tool error (never a fabricated answer)", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ cancelled: true, reason: "turn aborted" }), { status: 200 }),
    );
    await expect(
      callAskUserQuestion({ baseUrl: "http://x", sessionKey: "s" }, { questions }, fetchImpl),
    ).rejects.toThrow(/cancelled.*turn aborted/i);
  });

  test("ripolla finché l'umano non risponde: {pending} non è una risposta", async () => {
    // Il server chiude ogni gamba dopo pochi secondi (un socket tenuto aperto a
    // vuoto per minuti viene ucciso dal lato client — è successo davvero). Il
    // bridge deve tornare indietro, non arrendersi.
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      if (calls < 3) return new Response(JSON.stringify({ pending: true }), { status: 200 });
      return new Response(JSON.stringify({ answers: { Auth: "JWT" } }), { status: 200 });
    });
    const text = await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "s" },
      { questions },
      fetchImpl,
    );
    expect(calls).toBe(3);
    expect(JSON.parse(text)).toEqual({ answers: { Auth: "JWT" } });
  });

  test("un socket caduto viene ritentato, non trasformato in cancellazione", async () => {
    // L'umano sta ancora guardando il pannello: un errore di trasporto non deve
    // mai cancellare la sua domanda.
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify({ answers: { Auth: "OAuth" } }), { status: 200 });
    });
    const text = await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "s" },
      { questions },
      fetchImpl,
      { backoffMs: [0] },
    );
    expect(calls).toBe(2);
    expect(JSON.parse(text)).toEqual({ answers: { Auth: "OAuth" } });
  });

  test("se il server non risponde più, si arrende con un messaggio di trasporto", async () => {
    const fetchImpl = stubFetch(async () => { throw new Error("ECONNREFUSED"); });
    let t = 0;
    await expect(
      callAskUserQuestion({ baseUrl: "http://x", sessionKey: "s" }, { questions }, fetchImpl, {
        backoffMs: [0], transportGraceMs: 1_000, now: () => (t += 400),
      }),
    ).rejects.toThrow(/lost contact with topics-app.*ECONNREFUSED/i);
  });

  test("un riavvio del server non ammazza la domanda: si ritenta finché non torna su", async () => {
    // Il caso reale, misurato: qualcuno salva un file sotto `server/`, il
    // watcher fa un hot-reload graceful e fra SIGTERM, grazia dei provider,
    // rilancio e boot passano ~20 secondi. Il vecchio budget era un CONTEGGIO
    // (5 tentativi ≈ 15,5s): la domanda moriva con «lost contact» mentre
    // l'umano la stava ancora leggendo. Il rendez-vous si ricrea da solo alla
    // prima gamba che riesce, quindi ritentare è tutto ciò che serve.
    let calls = 0;
    let clock = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      // 12 gambe a vuoto ≈ un riavvio lento: prima si arrendeva alla sesta.
      if (calls <= 12) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ answers: { Auth: "OAuth" } }), { status: 200 });
    });
    const text = await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "s" },
      { questions },
      fetchImpl,
      { backoffMs: [0], now: () => (clock += 2_000) }, // 2s di orologio per tentativo
    );
    expect(calls).toBe(13);
    expect(JSON.parse(text)).toEqual({ answers: { Auth: "OAuth" } });
  });

  test("il budget è a TEMPO e riparte da capo dopo ogni risposta buona", async () => {
    // Due cadute separate da una gamba andata a buon fine non si sommano: è la
    // differenza fra «il server è giù» e «la rete ogni tanto singhiozza».
    let calls = 0;
    let clock = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      if (calls === 1 || calls === 3) throw new Error("socket hang up");
      if (calls === 2) return new Response(JSON.stringify({ pending: true }), { status: 200 });
      return new Response(JSON.stringify({ answers: { Auth: "JWT" } }), { status: 200 });
    });
    const text = await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "s" },
      { questions },
      fetchImpl,
      { backoffMs: [0], transportGraceMs: 1_000, now: () => (clock += 900) },
    );
    expect(JSON.parse(text)).toEqual({ answers: { Auth: "JWT" } });
  });

  test("non gira all'infinito se il server risponde 'pending' per sempre", async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({ pending: true }), { status: 200 }));
    await expect(
      callAskUserQuestion({ baseUrl: "http://x", sessionKey: "s" }, { questions }, fetchImpl, { maxLegs: 3 }),
    ).rejects.toThrow(/gave up after 3 poll legs/i);
  });

  test("ogni gamba senza risposta dice 'ci sono ancora': il silenzio è ciò che ammazza la domanda", async () => {
    // Il difetto vero: il pannello sopravviveva al socket e allo sweeper, ma il
    // CLIENT MCP chiudeva la chiamata dopo 30 minuti «senza risposta né
    // progress». Il progress è l'unica cosa che riazzera quel timer, quindi ogni
    // gamba pendente ne deve emettere uno — e nessuno quando l'umano risponde.
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      if (calls < 4) return new Response(JSON.stringify({ pending: true }), { status: 200 });
      return new Response(JSON.stringify({ answers: { Auth: "JWT" } }), { status: 200 });
    });
    const progress: number[] = [];
    await callAskUserQuestion(
      { baseUrl: "http://x", sessionKey: "s" },
      { questions },
      fetchImpl,
      { onProgress: (leg) => progress.push(leg) },
    );
    expect(progress).toEqual([1, 2, 3]);
  });

  test("il tetto delle gambe non decide mai la morte di una domanda: sta sopra il TTL del server", () => {
    // Chi chiude una domanda è il SERVER (`cancelled`), non questo ciclo. Il
    // tetto delle gambe è solo un anti-giro-a-vuoto, e se scende sotto il TTL
    // diventa lui a uccidere il pannello — con il messaggio sbagliato («gave up
    // after N poll legs») al posto di quello vero. È già successo: 500 gambe da
    // 25 s = 3 h 28, che stava sopra il TTL di 90 minuti di allora e sotto
    // quello di adesso. Il margine si prova, non si ricorda.
    expect(ASK_MAX_LEGS * ASK_LEG_MS).toBeGreaterThan(ASK_TTL_MS);
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

  test("forwards isolation only when asked, and renders the branch back", async () => {
    const seen: { init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (_url, init) => {
      seen.init = init;
      return new Response(
        JSON.stringify({ agentId: "kid1", name: "worker", cwd: "/wt/kind-tower", branch: "topics/kind-tower" }),
        { status: 200 },
      );
    });
    const text = await callSpawnAgent(
      { baseUrl: "http://x", sessionKey: "s" },
      { prompt: "go", isolation: "worktree" },
      fetchImpl,
    );
    expect(JSON.parse(String(seen.init?.body))).toEqual({ prompt: "go", isolation: "worktree" });
    expect(text).toContain("branch=topics/kind-tower");
    expect(text).toContain("cwd=/wt/kind-tower");
  });

  test("a spawn without a branch reads exactly as it did before", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ agentId: "kid1", name: "worker", cwd: "/p" }), { status: 200 }),
    );
    const text = await callSpawnAgent({ baseUrl: "http://x", sessionKey: "s" }, { prompt: "go" }, fetchImpl);
    expect(text).not.toContain("branch=");
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
    expect(text).not.toContain("branch=");
  });

  test("list and stop name the branch of an isolated child", async () => {
    const listed = await callListAgents(
      { baseUrl: "http://x", sessionKey: "s" },
      {},
      stubFetch(async () => new Response(JSON.stringify({ agents: [
        { agentId: "kid1", name: "worker", cwd: "/wt/kind-tower", branch: "topics/kind-tower", busy: false },
      ] }), { status: 200 })),
    );
    expect(listed).toContain("branch=topics/kind-tower");

    const stopped = await callStopAgent(
      { baseUrl: "http://x", sessionKey: "s" },
      { agent_id: "kid1" },
      stubFetch(async () => new Response(JSON.stringify({ ok: true, branch: "topics/kind-tower" }), { status: 200 })),
    );
    // The directory is judged later by the sweep; the commits are not, so the
    // stop is the moment the parent has to be handed the branch.
    expect(stopped).toContain("branch=topics/kind-tower");
    expect(stopped).toContain("git log main..topics/kind-tower");
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

// ---------------------------------------------------------------------------
// Bridge transport: one deadline per request, and a single second send
// ---------------------------------------------------------------------------

describe("bridge transport — timeout e ritentativo", () => {
  const args = { baseUrl: "http://x", sessionKey: "s" };
  const ok = () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  });

  test("ogni richiesta porta una scadenza: fetch da solo non ne ha nessuna", async () => {
    let seenSignal: unknown;
    const fetchImpl = stubFetch(async (_url, init) => { seenSignal = init?.signal; return ok(); });
    await callBrowserBridge(args, {}, "observe", fetchImpl);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  test("endpoint di sola lettura: una richiesta persa si rimanda, una volta sola", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return ok();
    });
    const out = await callBrowserBridge(args, {}, "observe", fetchImpl);
    expect(calls).toBe(2);
    expect(out).toContain("ok");
  });

  test("due perdite di fila: si arrende, e l'errore dice la chiamata, non il meccanismo", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async () => { calls++; throw new TypeError("fetch failed"); });
    await expect(callBrowserBridge(args, {}, "observe", fetchImpl)).rejects.toThrow(/browser\/observe/);
    expect(calls).toBe(2);
  });

  test("un'azione NON si rimanda: un clic ripetuto e' un clic che nessuno ha chiesto", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async () => { calls++; throw new TypeError("fetch failed"); });
    await expect(callBrowserBridge(args, {}, "act", fetchImpl)).rejects.toThrow(/act/);
    expect(calls).toBe(1);
  });

  test("una risposta arrivata e' una risposta, anche se e' un 500: non si rimanda", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    });
    await expect(callBrowserBridge(args, {}, "observe", fetchImpl)).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });

  test("una GET si rimanda da se', senza che nessuno lo dichiari", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ scripts: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const out = await callListProcesses(args, {}, fetchImpl);
    expect(calls).toBe(2);
    expect(out).toContain("No processes");
  });
});
