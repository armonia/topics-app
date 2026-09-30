/**
 * A MESSAGE IS NEVER WRITTEN INTO A TURN THE CLI OPENED BY ITSELF.
 *
 * Production, 27/09, chat 33966f4e (CLI ace58bc1): a background generation
 * reported back, the CLI opened a turn on its own at 21:42:11.356, and the
 * person's message arrived 2.0 s later. Topics had not adopted that turn yet
 * (adoption waited for the model's first line, 9.8 s in), the 409 gate was open,
 * and the message went to stdin: the CLI injected it after the next tool result
 * and the model answered it in the middle of the other turn. 4 such cases in 14
 * days, 291 turns opened by notifications in the same window.
 *
 * The provider side of the fix, the same code for the direct child and the
 * broker (they differ only in `io`): the CLI is "in a turn" from its
 * `system/init` to its `result`, the ledger hears it (`observeCliTurns`), and a
 * send that finds it busy waits for that `result` before writing.
 *
 * @covers CHAT-QUEUE-07
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import type { StreamHandler } from "./types";

const INIT = { type: "system", subtype: "init" };
const text = (t: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const result = (t: string) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: t, duration_ms: 10 });

function stubProcess(provider: ClaudeCodeProvider, sessionKey: string) {
  const writes: string[] = [];
  const signals: string[] = [];
  const pp: any = {
    proc: null,
    readline: { on() {}, close() {} },
    io: { writeStdin: (d: string) => { writes.push(d); }, signal: (s: string) => { signals.push(s); }, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "s", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    settledToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as any).processes.set(sessionKey, pp);
  return { pp, writes, signals };
}

function handler() {
  const texts: string[] = [];
  let done: string | null = null;
  let aborted = false;
  const h: StreamHandler = {
    onTextDelta: (t: string) => { texts.push(t); },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (r) => { done = r?.result ?? ""; },
    onError: () => {},
    onAborted: () => { aborted = true; },
  };
  return { h, texts, get done() { return done; }, get aborted() { return aborted; } };
}

const emit = (provider: ClaudeCodeProvider, pp: unknown, event: unknown) => (provider as any).handleStreamEvent(pp, event);
const settle = () => new Promise((r) => setTimeout(r, 0));
const userLines = (writes: string[]) => writes.filter((w) => w.includes('"type":"user"'));

const providers: Array<{ provider: ClaudeCodeProvider; pp: unknown }> = [];
afterEach(() => {
  for (const { provider, pp } of providers.splice(0)) (provider as any).cleanupTimers(pp);
  ClaudeCodeProvider.observeWokenTurns(() => false);
  ClaudeCodeProvider.observeCliTurns(() => {});
});

function setup(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const stub = stubProcess(provider, sessionKey);
  providers.push({ provider, pp: stub.pp });
  const cli: string[] = [];
  ClaudeCodeProvider.observeCliTurns((sk, open) => { if (sk === sessionKey) cli.push(open ? "open" : "closed"); });
  return { provider, ...stub, cli };
}

describe("claude-code: the CLI's own turn holds the session", () => {
  test("from its system/init to its result, reported to the ledger", () => {
    const { provider, pp, cli } = setup("topic:cli-open");
    emit(provider, pp, INIT);
    expect(provider.isCliTurnOpen("topic:cli-open")).toBe(true);
    emit(provider, pp, result(""));
    expect(provider.isCliTurnOpen("topic:cli-open")).toBe(false);
    expect(cli).toEqual(["open", "closed"]);
  });

  test("the idle sentinel is not the end of a turn", () => {
    const { provider, pp } = setup("topic:cli-sentinel");
    emit(provider, pp, INIT);
    emit(provider, pp, { type: "result", result: "waiting for message" });
    expect(provider.isCliTurnOpen("topic:cli-sentinel")).toBe(true);
  });

  test("the child's exit ends it", () => {
    const { provider, pp, cli } = setup("topic:cli-exit");
    emit(provider, pp, INIT);
    (provider as any).onSessionClosed(pp, 1);
    expect(cli).toEqual(["open", "closed"]);
  });
});

describe("claude-code: a send waits for the turn the CLI opened by itself", () => {
  test("nothing reaches stdin before that turn's result; the message is written right after", async () => {
    const { provider, pp, writes } = setup("topic:park");
    // The adopter takes the spontaneous turn at its first line, as the route does.
    const adopter = handler();
    ClaudeCodeProvider.observeWokenTurns((sk) => { provider.adoptWokenTurn(sk, adopter.h); return true; });

    emit(provider, pp, { type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
    emit(provider, pp, INIT);

    const sent = handler();
    provider.registerStreamHandler("topic:park", undefined, sent.h);
    const send = provider.sendChat("topic:park", "the person's message", sent.h);
    await settle();
    expect(userLines(writes)).toEqual([]);

    // The spontaneous turn runs: several messages, a tool, all while the send waits.
    emit(provider, pp, text("report of the background task"));
    emit(provider, pp, { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
    emit(provider, pp, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
    await settle();
    expect(userLines(writes)).toEqual([]);
    emit(provider, pp, result("report done"));
    await settle();

    // Its output went to its own row, not to the message waiting behind it.
    expect(adopter.done).toBe("report done");
    expect(sent.texts).toEqual([]);
    expect(userLines(writes)).toHaveLength(1);
    expect(userLines(writes)[0]).toContain("the person's message");

    // The message's own turn.
    emit(provider, pp, INIT);
    emit(provider, pp, text("answer"));
    emit(provider, pp, result("answer"));
    await send;
    expect(sent.done).toBe("answer");
  });

  test("a handler registered for a message not written yet does not take a turn that starts now", async () => {
    const { provider, pp, writes } = setup("topic:prereg");
    const adopter = handler();
    ClaudeCodeProvider.observeWokenTurns((sk) => { provider.adoptWokenTurn(sk, adopter.h); return true; });
    const sent = handler();
    provider.registerStreamHandler("topic:prereg", undefined, sent.h);
    expect(pp.streamHandler).toBe(sent.h);
    // The cron fires before the send reached stdin.
    emit(provider, pp, INIT);
    expect(pp.streamHandler).toBeNull();
    const send = provider.sendChat("topic:prereg", "msg", sent.h);
    emit(provider, pp, text("cron says hi"));
    await settle();
    expect(userLines(writes)).toEqual([]);
    emit(provider, pp, result("cron says hi"));
    await settle();
    expect(adopter.done).toBe("cron says hi");
    expect(userLines(writes)).toHaveLength(1);
    emit(provider, pp, INIT);
    emit(provider, pp, result("mine"));
    await send;
    expect(sent.done).toBe("mine");
  });

  test("a turn held for its adopter keeps the send waiting until the adopter takes it", async () => {
    const { provider, pp, writes } = setup("topic:held");
    // The adoption is asynchronous (the route opens a row first).
    ClaudeCodeProvider.observeWokenTurns(() => true);
    emit(provider, pp, INIT);
    emit(provider, pp, text("short wake"));
    emit(provider, pp, result("short wake"));
    expect(provider.isCliTurnOpen("topic:held")).toBe(false);
    const sent = handler();
    const send = provider.sendChat("topic:held", "msg", sent.h);
    await new Promise((r) => setTimeout(r, 300));
    expect(userLines(writes)).toEqual([]);
    const adopter = handler();
    expect(provider.adoptWokenTurn("topic:held", adopter.h)).toBe(true);
    expect(adopter.done).toBe("short wake");
    await new Promise((r) => setTimeout(r, 300));
    expect(userLines(writes)).toHaveLength(1);
    emit(provider, pp, INIT);
    emit(provider, pp, result("after"));
    await send;
    expect(sent.done).toBe("after");
  });

  test("stopped while it waits: nothing is written, and the Stop reaches the CLI's own turn it waited behind", async () => {
    // Before the park the message went to stdin and the Stop's SIGINT ended
    // both. Parked, the Stop found only the parked send and returned: the
    // CLI's turn, the one on screen, went on.
    const { provider, pp, writes, signals } = setup("topic:park-stop");
    const adopter = handler();
    ClaudeCodeProvider.observeWokenTurns((sk) => { provider.adoptWokenTurn(sk, adopter.h); return true; });
    emit(provider, pp, INIT);
    emit(provider, pp, text("working"));
    const sent = handler();
    const send = provider.sendChat("topic:park-stop", "msg", sent.h);
    await settle();
    await provider.abort("topic:park-stop", undefined, "user");
    expect(await send).toEqual({ runId: undefined, notSent: true });
    expect(sent.aborted).toBe(true);
    expect(signals).toEqual(["SIGINT"]);
    expect(adopter.aborted).toBe(true);
    expect(userLines(writes)).toEqual([]);
  });

  test("a cron fired right after a result, adopted through the route, then Stop: the CLI is interrupted and not adopted again", async () => {
    // The scenario of the spec: the queue leaves on the result, the send parks
    // behind the cron's wake, the CLI opens the cron's turn and the chat
    // adopts it. The Stop route calls abort and then drops the handler.
    const sk = "topic:cron-stop";
    const { provider, pp, writes, signals } = setup(sk);
    const adopters: ReturnType<typeof handler>[] = [];
    ClaudeCodeProvider.observeWokenTurns((s) => { const a = handler(); adopters.push(a); provider.adoptWokenTurn(s, a.h); return true; });
    emit(provider, pp, { type: "command_lifecycle", state: "started", command_uuid: "cron-x" });
    const sent = handler();
    provider.registerStreamHandler(sk, undefined, sent.h);
    const send = provider.sendChat(sk, "queued message", sent.h);
    await settle();
    emit(provider, pp, INIT);
    emit(provider, pp, text("cron turn working"));
    expect(adopters).toHaveLength(1);
    await provider.abort(sk, undefined, "user");
    provider.unregisterStreamHandler(sk);
    expect(await send).toEqual({ runId: undefined, notSent: true });
    expect(signals).toEqual(["SIGINT"]);
    expect(adopters[0]!.aborted).toBe(true);
    // The CLI dies on the SIGINT; a line it still prints is nobody's new turn.
    emit(provider, pp, text("cron turn still working after Stop"));
    expect(adopters).toHaveLength(1);
    expect(userLines(writes)).toEqual([]);
  });

  test("stopped while parked only behind a wake that has not opened a turn: the send is dropped, the idle CLI is not signalled", async () => {
    const { provider, pp, writes, signals } = setup("topic:park-stop-idle");
    emit(provider, pp, { type: "command_lifecycle", state: "started", command_uuid: "cron-3" });
    const sent = handler();
    const send = provider.sendChat("topic:park-stop-idle", "msg", sent.h);
    await settle();
    await provider.abort("topic:park-stop-idle", undefined, "user");
    expect(await send).toEqual({ runId: undefined, notSent: true });
    expect(signals).toEqual([]);
    expect(userLines(writes)).toEqual([]);
  });

  test("a cron fired right after a result, its init not come yet: the send waits for that turn too", async () => {
    // The CLI holds a cron's fire until the result of the turn before and
    // starts it 11 ms later, its init 182 ms after that (recorded 28/09). A
    // queue drained on that result reached stdin in the gap.
    const { provider, pp, writes } = setup("topic:wake-gap");
    const adopter = handler();
    ClaudeCodeProvider.observeWokenTurns((sk) => { provider.adoptWokenTurn(sk, adopter.h); return true; });
    emit(provider, pp, { type: "command_lifecycle", state: "started", command_uuid: "cron-1" });

    const sent = handler();
    provider.registerStreamHandler("topic:wake-gap", undefined, sent.h);
    expect(pp.streamHandler).toBeNull();
    const send = provider.sendChat("topic:wake-gap", "msg", sent.h);
    await settle();
    expect(userLines(writes)).toEqual([]);

    emit(provider, pp, INIT);
    emit(provider, pp, text("cron turn"));
    await new Promise((r) => setTimeout(r, 300));
    expect(userLines(writes)).toEqual([]);
    emit(provider, pp, result("cron turn"));
    await settle();
    expect(adopter.done).toBe("cron turn");
    expect(userLines(writes)).toHaveLength(1);
    emit(provider, pp, INIT);
    emit(provider, pp, result("mine"));
    await send;
    expect(sent.done).toBe("mine");
  });

  test("a queued wake that opens no turn holds the send only for the recorded gap", async () => {
    const { provider, pp, writes } = setup("topic:wake-none");
    emit(provider, pp, { type: "command_lifecycle", state: "started", command_uuid: "cron-2" });
    // Queued 1.8 s ago: the grace is almost over, and no init came.
    pp.background.wakeQueuedAt -= 1_800;
    const sent = handler();
    const send = provider.sendChat("topic:wake-none", "msg", sent.h);
    await settle();
    expect(userLines(writes)).toEqual([]);
    await new Promise((r) => setTimeout(r, 600));
    expect(userLines(writes)).toHaveLength(1);
    emit(provider, pp, INIT);
    emit(provider, pp, result("ok"));
    await send;
    expect(sent.done).toBe("ok");
  });

  test("an idle CLI: the send writes at once", async () => {
    const { provider, pp, writes } = setup("topic:idle");
    const sent = handler();
    const send = provider.sendChat("topic:idle", "msg", sent.h);
    await settle();
    expect(userLines(writes)).toHaveLength(1);
    emit(provider, pp, INIT);
    emit(provider, pp, result("ok"));
    await send;
    expect(sent.done).toBe("ok");
  });
});
