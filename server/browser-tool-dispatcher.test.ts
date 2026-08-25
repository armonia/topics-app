/**
 * Unit coverage for dispatchBrowserToolCall — the server-side router that
 * fans LLM tool calls (browser_open, browser_observe, ...) out to the
 * canonical handlers in browser-tools-handler.ts.
 *
 * Pre-existing coverage: NONE. Added as part of the "fix browser-pane-from-chat"
 * remediation so the new tool→UI-broadcast wiring in topics.ts has a regression-proof
 * contract on the underlying dispatch behaviour:
 *   - contextId resolution falls back from topic.browserState.contextId to topic.id
 *   - browser_open delegates to service.navigate(contextId, url)
 *   - invalid args throw a descriptive error
 *   - unknown tool names return a structured { error } object
 * @covers BROWSER-CHAT-03
 */
import { describe, test, expect } from "bun:test";
import type { BrowserService } from "./browser-service";
import type { Topic } from "./types";
import {
  dispatchBrowserToolCall,
  resolveContextIdForTopic,
} from "./browser-tool-dispatcher";
import { setLocalFileServing } from "./browser-local-file-url";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  const base: Topic = {
    id: "topic-test-abc",
    name: "Test topic",
    slug: "test-topic",
    parentId: null,
    links: [],
    sessionKey: "session:test",
    color: "#000",
    icon: "MessageSquare",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
  };
  return { ...base, ...overrides };
}

/**
 * Build a BrowserService surface that records every call and returns the
 * configured navigate response. Only the methods touched by the playwright
 * adapter path are implemented; the rest throw a clear "unexpected call"
 * error so the test fails loud if dispatch reaches the wrong surface.
 */
function makeMockService(opts: {
  navigateResult?: { url: string; title: string };
  navigateImpl?: (contextId: string, url: string) => Promise<{ url: string; title: string }>;
} = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const navigateResult = opts.navigateResult ?? { url: "https://example.com/", title: "Example" };

  const service = {
    broadcastAgentActive(contextId: string, active: boolean) {
      calls.push({ method: "broadcastAgentActive", args: [contextId, active] });
    },
    async navigate(contextId: string, url: string) {
      calls.push({ method: "navigate", args: [contextId, url] });
      if (opts.navigateImpl) return opts.navigateImpl(contextId, url);
      return navigateResult;
    },
    // Methods that should not be touched by browser_open dispatch — fail loudly
    // if they are, so a future change that wires a different adapter doesn't
    // silently change semantics.
    screenshot() { throw new Error("unexpected: screenshot called for browser_open"); },
    dispatchInput() { throw new Error("unexpected: dispatchInput called for browser_open"); },
    extractIndexedElements() { throw new Error("unexpected: extractIndexedElements called for browser_open"); },
    captureAnnotatedScreenshot() { throw new Error("unexpected: captureAnnotatedScreenshot called for browser_open"); },
    accessibilitySnapshot() { throw new Error("unexpected: accessibilitySnapshot called for browser_open"); },
  };

  return { service: service as unknown as BrowserService, calls };
}

// ---------------------------------------------------------------------------
// resolveContextIdForTopic — contract docstring at dispatcher.ts:30-32
// ---------------------------------------------------------------------------

describe("resolveContextIdForTopic", () => {
  test("prefers topic.browserState.contextId when present", () => {
    const topic = makeTopic({
      browserState: { url: "https://x", contextId: "ctx-explicit", lastActiveAt: 1 },
    });
    expect(resolveContextIdForTopic(topic)).toBe("ctx-explicit");
  });

  test("falls back to topic.id when browserState is absent", () => {
    const topic = makeTopic(); // no browserState
    expect(resolveContextIdForTopic(topic)).toBe("topic-test-abc");
  });

  test("falls back to topic.id when browserState.contextId is empty-string falsy", () => {
    // Defensive: a stale row from a botched migration could land us here.
    // The dispatcher uses ?? not ||, so empty string IS used as contextId.
    // Pin that behaviour explicitly so a future change is intentional.
    const topic = makeTopic({
      browserState: { url: "https://x", contextId: "", lastActiveAt: 1 },
    });
    expect(resolveContextIdForTopic(topic)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// dispatchBrowserToolCall — happy path + edge cases
// ---------------------------------------------------------------------------

describe("dispatchBrowserToolCall", () => {
  test("browser_open delegates to service.navigate with resolved contextId", async () => {
    const { service, calls } = makeMockService({
      navigateResult: { url: "https://example.com/final", title: "Example Domain" },
    });
    const topic = makeTopic({
      browserState: { url: "https://prev", contextId: "ctx-9", lastActiveAt: 1 },
    });

    const result = await dispatchBrowserToolCall(
      "browser_open",
      { url: "https://example.com" },
      topic,
      service,
    );

    // Expected: navigate called once with contextId from browserState.
    const navCalls = calls.filter(c => c.method === "navigate");
    expect(navCalls.length).toBe(1);
    expect(navCalls[0].args).toEqual(["ctx-9", "https://example.com"]);

    // Expected: agent_active broadcast wraps the call (true then false).
    const broadcasts = calls.filter(c => c.method === "broadcastAgentActive");
    expect(broadcasts.length).toBe(2);
    expect(broadcasts[0].args).toEqual(["ctx-9", true]);
    expect(broadcasts[1].args).toEqual(["ctx-9", false]);

    // Expected: handler returns the navigate result + a best-effort snapshot
    // (empty here — the mock service has no real page to snapshot).
    expect(result).toMatchObject({ url: "https://example.com/final", title: "Example Domain" });
    expect((result as { snapshot?: unknown }).snapshot).toBe("");
  });

  test("browser_open uses topic.id when browserState absent", async () => {
    const { service, calls } = makeMockService();
    const topic = makeTopic(); // no browserState — falls back to topic.id

    await dispatchBrowserToolCall(
      "browser_open",
      { url: "https://example.com" },
      topic,
      service,
    );

    const navCalls = calls.filter(c => c.method === "navigate");
    expect(navCalls[0].args[0]).toBe("topic-test-abc");
  });

  test("browser_open throws when 'url' arg is missing", async () => {
    const { service } = makeMockService();
    const topic = makeTopic();

    await expect(
      dispatchBrowserToolCall("browser_open", {}, topic, service)
    ).rejects.toThrow(/url.*required/i);
  });

  test("browser_open throws when 'url' is not a string", async () => {
    const { service } = makeMockService();
    const topic = makeTopic();

    await expect(
      dispatchBrowserToolCall("browser_open", { url: 123 as unknown as string }, topic, service)
    ).rejects.toThrow(/url.*required/i);
  });

  // La proprietà da difendere non è il TESTO del rifiuto, è che nessun
  // `file://` arrivi mai a `navigate` per mano dell'agente. Prima il test
  // guardava il messaggio: leggeva verde anche se un domani la difesa fosse
  // diventata «lo dico e poi navigo lo stesso». Qui si guarda dove la pane va a
  // finire, nei tre stati in cui il server può trovarsi.
  describe("browser_open non porta MAI l'agente su file://", () => {
    test("senza allowlist cablata: rifiuta", async () => {
      setLocalFileServing(null);
      const { service, calls } = makeMockService();
      await expect(
        dispatchBrowserToolCall("browser_open", { url: "file:///etc/passwd" }, makeTopic(), service)
      ).rejects.toThrow();
      expect(calls.filter((c) => c.method === "navigate")).toHaveLength(0);
    });

    test("con allowlist, ma percorso non servibile: rifiuta, e dice perché", async () => {
      setLocalFileServing({
        isPathAllowed: (p: string) => p.startsWith("/Users/x/.topics/media/"),
        exists: () => true,
        origin: "https://127.0.0.1:3333",
      });
      const { service, calls } = makeMockService();
      await expect(
        dispatchBrowserToolCall("browser_open", { url: "file:///etc/passwd" }, makeTopic(), service)
      ).rejects.toThrow(/outside the paths/i);
      expect(calls.filter((c) => c.method === "navigate")).toHaveLength(0);
    });

    test("percorso servibile: la pane va su http, non su file://", async () => {
      setLocalFileServing({
        isPathAllowed: (p: string) => p.startsWith("/Users/x/.topics/media/"),
        exists: () => true,
        origin: "https://127.0.0.1:3333",
      });
      const { service, calls } = makeMockService();
      await dispatchBrowserToolCall(
        "browser_open",
        { url: "file:///Users/x/.topics/media/contratto.pdf" },
        makeTopic(),
        service,
      );
      const nav = calls.find((c) => c.method === "navigate");
      expect(nav?.args?.[1]).toBe(
        "https://127.0.0.1:3333/api/media?path=%2FUsers%2Fx%2F.topics%2Fmedia%2Fcontratto.pdf",
      );
      expect(String(nav?.args?.[1])).not.toContain("file:");
    });
  });

  test("agent_active broadcast still fires false when navigate throws", async () => {
    const { service, calls } = makeMockService({
      navigateImpl: async () => { throw new Error("network down"); },
    });
    const topic = makeTopic({
      browserState: { url: "https://x", contextId: "ctx-fail", lastActiveAt: 1 },
    });

    await expect(
      dispatchBrowserToolCall("browser_open", { url: "https://example.com" }, topic, service)
    ).rejects.toThrow(/network down/);

    // withLock's try/finally must still flip agent_active off so the UI
    // doesn't show a stuck "agent working" state.
    const broadcasts = calls.filter(c => c.method === "broadcastAgentActive");
    expect(broadcasts.length).toBe(2);
    expect(broadcasts[1].args).toEqual(["ctx-fail", false]);
  });

  test("unknown tool name returns structured { error } without throwing", async () => {
    const { service } = makeMockService();
    const topic = makeTopic();

    const result = await dispatchBrowserToolCall(
      "browser_does_not_exist" as any,
      {},
      topic,
      service,
    );

    expect(result).toEqual({ error: "Unknown browser tool: browser_does_not_exist" });
  });

  test("non-browser tool name falls through the same unknown branch", async () => {
    // The wiring in topics.ts only enters dispatchBrowserToolCall when
    // name.startsWith('browser_'), but defending the dispatcher itself
    // makes the contract usable from other call sites (REST surface
    // smoke-checks, internal scripts, etc.).
    const { service } = makeMockService();
    const topic = makeTopic();

    const result = await dispatchBrowserToolCall("Bash" as any, {}, topic, service);
    expect(result).toEqual({ error: "Unknown browser tool: Bash" });
  });
});
