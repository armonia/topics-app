/**
 * Terminal memory: a terminal reopened after its PTY was retired comes back in
 * its own folder with its Claude conversation, not as an empty `claude` in the
 * project root (the «empty terminal» of ⇧⌘T).
 *
 * @covers CMD-03, CMD-04
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetTerminalMemory, rememberTerminals, rememberedAgentType, rememberedTerminal } from "./terminalMemory";
import { reopenClosedTab, type ClosedTabRecord } from "./closedTabRecord";

const session = (id: string, extra: Partial<Parameters<typeof rememberTerminals>[0][number]> = {}) => ({
  id, name: `name-${id}`, cwd: `/Users/x/Projects/acme-night/${id}`, type: "claude-code" as const, claudeSessionId: `cs-${id}`, ...extra,
});

describe("rememberTerminals", () => {
  beforeEach(() => __resetTerminalMemory());

  test("keeps a session after the roster drops it", () => {
    rememberTerminals([session("a"), session("b")]);
    rememberTerminals([session("b")]);
    expect(rememberedTerminal("a")?.cwd).toBe("/Users/x/Projects/acme-night/a");
    expect(rememberedTerminal("a")?.claudeSessionId).toBe("cs-a");
  });

  test("a later roster without the conversation id keeps the one it had", () => {
    rememberTerminals([session("a")]);
    rememberTerminals([session("a", { claudeSessionId: null, name: "renamed" })]);
    expect(rememberedTerminal("a")?.claudeSessionId).toBe("cs-a");
    expect(rememberedTerminal("a")?.name).toBe("renamed");
  });

  test("bounded: the oldest fall off", () => {
    rememberTerminals(Array.from({ length: 310 }, (_, i) => session(`s${i}`)));
    expect(rememberedTerminal("s0")).toBeUndefined();
    expect(rememberedTerminal("s309")).toBeDefined();
  });

  test("a close record holds only a pane's agent types", () => {
    rememberTerminals([session("a"), session("t", { type: "claude-code-team" })]);
    expect(rememberedAgentType(rememberedTerminal("a"))).toBe("claude-code");
    expect(rememberedAgentType(rememberedTerminal("t"))).toBeUndefined();
    expect(rememberedAgentType(undefined)).toBeUndefined();
  });
});

describe("reopenClosedTab recreates a retired terminal as itself", () => {
  class MemoryStorage {
    private m = new Map<string, string>();
    getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
    setItem(k: string, v: string) { this.m.set(k, String(v)); }
    removeItem(k: string) { this.m.delete(k); }
    clear() { this.m.clear(); }
  }
  let realFetch: typeof fetch;
  let posted: Record<string, unknown> | null;

  beforeEach(() => {
    __resetTerminalMemory();
    posted = null;
    realFetch = globalThis.fetch;
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      // Neither live nor dormant: the row was retired 60 s after the close.
      if (method === "GET" || String(url).endsWith("/revive")) return { ok: false, status: 404, json: async () => ({}) };
      if (method === "POST" && String(url).endsWith("/api/terminal/sessions")) {
        posted = JSON.parse(String(init?.body));
        return { ok: true, status: 200, json: async () => ({ id: "fresh", name: "x" }) };
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  // The record as the app-level reducer writes it: no folder, no type, no conversation.
  const bareRecord: ClosedTabRecord = {
    id: "terminal:a",
    closedAt: 1,
    pane: { id: "terminal:a", type: "terminal", title: "Acme" },
    groupId: "group:default",
    groupIndex: 0,
    level: "app",
    terminal: { sessionId: "a" },
  };

  test("its folder, its type and its conversation come from the memory", async () => {
    rememberTerminals([session("a")]);
    await reopenClosedTab(bareRecord);
    expect(posted).toMatchObject({ cwd: "/Users/x/Projects/acme-night/a", type: "claude-code", claudeSessionId: "cs-a" });
  });

  test("a project record's root folder gives way to the session's own", async () => {
    rememberTerminals([session("a")]);
    await reopenClosedTab({ ...bareRecord, level: "project", projectPath: "/Users/x", terminal: { cwd: "/Users/x", sessionType: "claude-code", name: "Acme", skipPermissions: true } });
    expect(posted).toMatchObject({ cwd: "/Users/x/Projects/acme-night/a", claudeSessionId: "cs-a", skipPermissions: true });
  });

  test("without memory it behaves as before: the record's own fields", async () => {
    await reopenClosedTab({ ...bareRecord, terminal: { cwd: "/p", sessionType: "shell", name: "sh" } });
    expect(posted).toMatchObject({ cwd: "/p", type: "shell", name: "sh" });
    expect(posted?.claudeSessionId).toBeUndefined();
  });
});
