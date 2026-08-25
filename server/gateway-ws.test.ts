/**
 * CHAT-REL-04 — an old run's events must not reach the current one.
 *
 * `gateway-ws.ts` is the switchboard: one handler per session key, and every
 * event the gateway pushes is matched against it. The requirement it carries
 * was named in the source and tested nowhere — the file had no test at all.
 *
 * WHAT GOES WRONG WITHOUT THE FILTER. A turn is aborted, the user sends a new
 * message, and the previous run's `error` (or `final`) arrives a moment later.
 * Matched to the session key alone it lands on the live handler, and the person
 * watching sees their brand-new turn fail with an error produced by the turn
 * they cancelled. Nothing crashes; the transcript simply lies.
 *
 * THE PART THAT LOOKS LIKE A BUG AND IS NOT. HTTP-path turns register with a
 * sentinel run id (`http:<uuid>`) that no gateway run can ever match, so for
 * CHAT events the filter rejects *everything* — deliberately: that turn's text
 * arrives over its own SSE body, and letting the WS copy through would print
 * the answer twice. For TOOL events the same sentinel is explicitly EXEMPTED,
 * because tool rows have no second channel: apply the filter there too and
 * every tool row silently disappears from HTTP-path turns.
 *
 * That asymmetry is one `&& !entry.runId.startsWith('http:')` apart, sits in
 * two branches that read almost identically, and is exactly the kind of thing
 * someone unifies while tidying up. Both directions of the mistake are covered
 * below, because each one alone would let the other pass.
 *
 * @covers CHAT-REL-04
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerSessionHandler,
  unregisterSessionHandler,
  routeGatewayEvent,
  type ChatStreamHandler,
  type GatewayEvent,
} from "./gateway-ws";

const SESSION = "topic:abc123";

/** A handler that records what it was told, so a test can assert on silence too. */
function spy() {
  const calls: string[] = [];
  const handler: ChatStreamHandler = {
    onTextDelta: (t) => void calls.push(`delta:${t}`),
    onThinkingDelta: (t) => void calls.push(`thinking:${t}`),
    onToolStart: (id, name) => void calls.push(`toolStart:${id}:${name}`),
    onToolUpdate: (id, p) => void calls.push(`toolUpdate:${id}:${p}`),
    onToolResult: (id, r) => void calls.push(`toolResult:${id}:${r}`),
    onDone: () => void calls.push("done"),
    onError: (e) => void calls.push(`error:${e}`),
    onAborted: () => void calls.push("aborted"),
  };
  return { calls, handler };
}

const chatEvent = (p: Record<string, unknown>): GatewayEvent =>
  ({ event: "chat", payload: { sessionKey: SESSION, ...p } }) as GatewayEvent;

const toolEvent = (runId: string | undefined, phase: string, toolCallId = "t1"): GatewayEvent =>
  ({
    event: "agent",
    payload: { sessionKey: SESSION, stream: "tool", runId, data: { phase, toolCallId, name: "Read", result: "ok" } },
  }) as GatewayEvent;

describe("stale runs are consumed and dropped", () => {
  let s: ReturnType<typeof spy>;
  beforeEach(() => { s = spy(); });
  afterEach(() => unregisterSessionHandler(SESSION));

  test("an error from a PREVIOUS run never reaches the current handler", () => {
    registerSessionHandler(SESSION, "run-2", s.handler);

    const handled = routeGatewayEvent(chatEvent({ state: "error", runId: "run-1", errorMessage: "the cancelled turn's error" }));

    expect(s.calls, "the user would see the old turn's failure on the new one").toEqual([]);
    // `true`, not `false`: the event WAS ours, and saying otherwise would send
    // it looking for another home further down the routing chain.
    expect(handled, "consumed, then ignored").toBe(true);
  });

  test("the same event on the MATCHING run does arrive", () => {
    // The non-vacuous half. Without it the test above passes for a filter that
    // drops everything, which is a different and equally silent bug.
    registerSessionHandler(SESSION, "run-2", s.handler);
    routeGatewayEvent(chatEvent({ state: "error", runId: "run-2", errorMessage: "boom" }));
    expect(s.calls).toEqual(["error:boom"]);
  });

  test("an event with no run id at all is delivered", () => {
    // The gateway does not stamp every event. Treating "no id" as "not mine"
    // would silently drop the events of any provider that omits it.
    registerSessionHandler(SESSION, "run-2", s.handler);
    routeGatewayEvent(chatEvent({ state: "final" }));
    expect(s.calls).toEqual(["done"]);
  });

  test("nothing routes to a session that has been unregistered", () => {
    registerSessionHandler(SESSION, "run-2", s.handler);
    unregisterSessionHandler(SESSION);
    expect(routeGatewayEvent(chatEvent({ state: "final", runId: "run-2" }))).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

describe("the http: sentinel, and why it is not symmetric", () => {
  let s: ReturnType<typeof spy>;
  const SENTINEL = "http:0f7a-4c11";
  beforeEach(() => { s = spy(); });
  afterEach(() => unregisterSessionHandler(SESSION));

  test("CHAT events are rejected wholesale — the SSE body already carries them", () => {
    registerSessionHandler(SESSION, SENTINEL, s.handler);
    routeGatewayEvent(chatEvent({ state: "delta", runId: "gw-1", message: { content: "hello" } }));
    routeGatewayEvent(chatEvent({ state: "final", runId: "gw-1" }));
    routeGatewayEvent(chatEvent({ state: "error", runId: "gw-1", errorMessage: "x" }));
    expect(s.calls, "letting these through prints the answer twice").toEqual([]);
  });

  test("TOOL events are EXEMPT — they have no second channel", () => {
    // The exception that looks like an oversight. Delete it and every tool row
    // vanishes from HTTP-path turns: no error, no log, just an agent that
    // appears to have done nothing while it worked.
    registerSessionHandler(SESSION, SENTINEL, s.handler);
    routeGatewayEvent(toolEvent("gw-1", "start"));
    routeGatewayEvent(toolEvent("gw-1", "result"));
    expect(s.calls).toEqual(["toolStart:t1:Read", "toolResult:t1:ok"]);
  });

  test("a NON-sentinel handler still drops a stale tool event", () => {
    // The other side of the exemption: it is scoped to `http:`, not a blanket
    // amnesty. A WS-path turn must not receive the previous run's tool rows.
    registerSessionHandler(SESSION, "run-2", s.handler);
    routeGatewayEvent(toolEvent("run-1", "start"));
    expect(s.calls).toEqual([]);
  });
});

describe("re-registering the same turn does not replay its text", () => {
  let s: ReturnType<typeof spy>;
  beforeEach(() => { s = spy(); });
  afterEach(() => unregisterSessionHandler(SESSION));

  test("the cumulative survives the route's second registration", () => {
    // The route registers TWICE for one turn — first without a run id, so no
    // event is lost while `sendChat` is still in flight, then with the real
    // one. The gateway sends the WHOLE message on every delta, so if the
    // second registration reset the running total, everything already shown
    // would be re-emitted as new: the answer printed twice inside one turn.
    registerSessionHandler(SESSION, undefined, s.handler);
    routeGatewayEvent(chatEvent({ state: "delta", message: { content: "Hel" } }));
    registerSessionHandler(SESSION, "run-2", s.handler);
    routeGatewayEvent(chatEvent({ state: "delta", runId: "run-2", message: { content: "Hello" } }));

    expect(s.calls, "the second delta must carry only what is new").toEqual(["delta:Hel", "delta:lo"]);
  });

  test("a DIFFERENT run id starts the count over", () => {
    // The opposite failure: carrying the total into a genuinely new turn would
    // swallow the beginning of the next answer, because it looks like text
    // already seen.
    registerSessionHandler(SESSION, "run-1", s.handler);
    routeGatewayEvent(chatEvent({ state: "delta", runId: "run-1", message: { content: "Hello" } }));
    registerSessionHandler(SESSION, "run-2", s.handler);
    routeGatewayEvent(chatEvent({ state: "delta", runId: "run-2", message: { content: "Hello" } }));

    expect(s.calls).toEqual(["delta:Hello", "delta:Hello"]);
  });
});
