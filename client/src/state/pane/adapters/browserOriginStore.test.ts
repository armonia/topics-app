/**
 * @covers BROWSER-STATE-02
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  recordBrowserOrigin,
  getBrowserOrigin,
  clearBrowserOrigin,
  enqueueProjectBrowserReopen,
  drainProjectBrowserReopens,
  enqueueProjectBrowserNavigate,
  drainProjectBrowserNavigates,
  resolvePinnedBrowserOrigin,
} from "./browserOriginStore";
import type { ClosedTabRecord } from "./closedTabRecord";

/**
 * The durable origin store is the closedStack-independent association that lets
 * a browser pinned INSIDE a project reopen back into that project with its url,
 * even after its bounded closedStack record is evicted. See browserOriginStore.ts.
 *
 * bun:test has no DOM, so we install a minimal in-memory localStorage shim.
 */

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

describe("recordBrowserOrigin / getBrowserOrigin", () => {
  test("round-trips projectPath + url + title for a contextId", () => {
    recordBrowserOrigin("ctx1", "/tmp/proj", "https://example.com", "Example");
    const o = getBrowserOrigin("ctx1");
    expect(o?.projectPath).toBe("/tmp/proj");
    expect(o?.url).toBe("https://example.com");
    expect(o?.title).toBe("Example");
    expect(typeof o?.ts).toBe("number");
  });

  test("unknown contextId → null", () => {
    expect(getBrowserOrigin("nope")).toBeNull();
  });

  test("empty contextId → null (never keys on '')", () => {
    expect(getBrowserOrigin("")).toBeNull();
  });

  test("ignores about:blank and empty urls (a dead pane can't clobber a good origin)", () => {
    recordBrowserOrigin("ctx1", "/tmp/proj", "https://good.com");
    recordBrowserOrigin("ctx1", "/tmp/proj", "about:blank");
    recordBrowserOrigin("ctx1", "/tmp/proj", "");
    expect(getBrowserOrigin("ctx1")?.url).toBe("https://good.com");
  });

  test("skips writes missing contextId or projectPath", () => {
    recordBrowserOrigin("", "/tmp/proj", "https://x.com");
    recordBrowserOrigin("ctx2", "", "https://x.com");
    expect(getBrowserOrigin("ctx2")).toBeNull();
  });

  test("a later url write updates the url and refreshes ts", () => {
    recordBrowserOrigin("ctx1", "/tmp/proj", "https://one.com", "One");
    recordBrowserOrigin("ctx1", "/tmp/proj", "https://two.com");
    const o = getBrowserOrigin("ctx1");
    expect(o?.url).toBe("https://two.com");
    // Merge semantics: a url-only write keeps the prior title.
    expect(o?.title).toBe("One");
  });

  test("clearBrowserOrigin removes only the target contextId", () => {
    recordBrowserOrigin("ctx1", "/tmp/a", "https://a.com");
    recordBrowserOrigin("ctx2", "/tmp/b", "https://b.com");
    clearBrowserOrigin("ctx1");
    expect(getBrowserOrigin("ctx1")).toBeNull();
    expect(getBrowserOrigin("ctx2")?.url).toBe("https://b.com");
  });
});

describe("pending project-browser reopen queue (not-open bridge)", () => {
  const rec = (id: string, projectPath: string): ClosedTabRecord => ({
    id: `browser:${id}`,
    closedAt: Date.now(),
    pane: { id: `browser:${id}`, type: "browser", title: "B", url: "https://x.com" },
    groupId: "",
    groupIndex: 0,
    level: "project",
    projectPath,
  });

  test("enqueue then drain returns the parked records for that project", () => {
    enqueueProjectBrowserReopen("/tmp/proj", rec("a", "/tmp/proj"));
    const out = drainProjectBrowserReopens("/tmp/proj");
    expect(out).toHaveLength(1);
    expect(out[0].pane.id).toBe("browser:a");
  });

  test("drain is one-shot — a second drain is empty", () => {
    enqueueProjectBrowserReopen("/tmp/proj", rec("a", "/tmp/proj"));
    drainProjectBrowserReopens("/tmp/proj");
    expect(drainProjectBrowserReopens("/tmp/proj")).toEqual([]);
  });

  test("de-dups by pane id (double-click can't queue twice)", () => {
    enqueueProjectBrowserReopen("/tmp/proj", rec("a", "/tmp/proj"));
    enqueueProjectBrowserReopen("/tmp/proj", rec("a", "/tmp/proj"));
    expect(drainProjectBrowserReopens("/tmp/proj")).toHaveLength(1);
  });

  test("queues are isolated per projectPath", () => {
    enqueueProjectBrowserReopen("/tmp/a", rec("a", "/tmp/a"));
    enqueueProjectBrowserReopen("/tmp/b", rec("b", "/tmp/b"));
    expect(drainProjectBrowserReopens("/tmp/a")).toHaveLength(1);
    expect(drainProjectBrowserReopens("/tmp/b")).toHaveLength(1);
  });

  test("draining an unknown project → empty array", () => {
    expect(drainProjectBrowserReopens("/never")).toEqual([]);
  });
});

describe("pending project-browser NAVIGATE queue (Apri nel workspace bridge)", () => {
  test("enqueue then drain returns the parked navigate", () => {
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "http://localhost:3400/", contextId: "task-abc" });
    const out = drainProjectBrowserNavigates("/tmp/proj");
    expect(out).toEqual([{ url: "http://localhost:3400/", contextId: "task-abc" }]);
  });

  test("drain empties the queue (a second drain is empty)", () => {
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "http://localhost:3400/", contextId: "task-abc" });
    drainProjectBrowserNavigates("/tmp/proj");
    expect(drainProjectBrowserNavigates("/tmp/proj")).toEqual([]);
  });

  test("de-dups by url+contextId so a double-click queues once", () => {
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "http://localhost:3400/", contextId: "task-abc" });
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "http://localhost:3400/", contextId: "task-abc" });
    expect(drainProjectBrowserNavigates("/tmp/proj")).toHaveLength(1);
  });

  test("same url, different contextId → two distinct entries", () => {
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "http://localhost:3400/", contextId: "task-abc" });
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "http://localhost:3400/", contextId: "task-def" });
    expect(drainProjectBrowserNavigates("/tmp/proj")).toHaveLength(2);
  });

  test("queues are isolated per project path", () => {
    enqueueProjectBrowserNavigate("/tmp/a", { url: "http://localhost:3400/", contextId: "a" });
    enqueueProjectBrowserNavigate("/tmp/b", { url: "http://localhost:3401/", contextId: "b" });
    expect(drainProjectBrowserNavigates("/tmp/a")).toHaveLength(1);
    expect(drainProjectBrowserNavigates("/tmp/b")).toHaveLength(1);
  });

  test("ignores an empty url or missing project path", () => {
    enqueueProjectBrowserNavigate("/tmp/proj", { url: "" });
    enqueueProjectBrowserNavigate("", { url: "http://localhost:3400/" });
    expect(drainProjectBrowserNavigates("/tmp/proj")).toEqual([]);
  });

  test("draining an unknown project → empty array", () => {
    expect(drainProjectBrowserNavigates("/never")).toEqual([]);
  });
});

describe("resolvePinnedBrowserOrigin (store ∪ closedStack)", () => {
  const closedRec = (
    paneId: string,
    projectPath: string,
    url: string,
    title?: string,
    level: "project" | "app" = "project",
    type: "browser" | "chat" = "browser",
  ): ClosedTabRecord => ({
    id: paneId,
    closedAt: 123,
    pane: { id: paneId, type, title: title ?? "B", url },
    groupId: "",
    groupIndex: 0,
    level,
    projectPath,
  });

  test("the durable store wins when both store and closedStack have it", () => {
    recordBrowserOrigin("ctx1", "/tmp/store", "https://store.com", "StoreTitle");
    const closed = [closedRec("browser:ctx1", "/tmp/stack", "https://stack.com", "StackTitle")];
    const o = resolvePinnedBrowserOrigin("browser:ctx1", closed);
    expect(o?.projectPath).toBe("/tmp/store");
    expect(o?.url).toBe("https://store.com");
    expect(o?.title).toBe("StoreTitle");
  });

  test("falls back to the closedStack record when the store has no origin", () => {
    const closed = [closedRec("browser:ctx1", "/tmp/stack", "https://stack.com", "StackTitle")];
    const o = resolvePinnedBrowserOrigin("browser:ctx1", closed);
    expect(o?.projectPath).toBe("/tmp/stack");
    expect(o?.url).toBe("https://stack.com");
    expect(o?.title).toBe("StackTitle");
  });

  test("ignores a non-project or non-browser closed record", () => {
    const appLevel = [closedRec("browser:ctx1", "/tmp/x", "https://x.com", "T", "app")];
    expect(resolvePinnedBrowserOrigin("browser:ctx1", appLevel)).toBeNull();
    const chatRec = [closedRec("browser:ctx1", "/tmp/x", "https://x.com", "T", "project", "chat")];
    expect(resolvePinnedBrowserOrigin("browser:ctx1", chatRec)).toBeNull();
  });

  test("a bare pin with neither source → null (genuinely unrecoverable)", () => {
    expect(resolvePinnedBrowserOrigin("browser:ctx1", [])).toBeNull();
  });

  test("matches the closed record by exact pane id, not contextId collision", () => {
    const closed = [closedRec("browser:other", "/tmp/x", "https://x.com")];
    expect(resolvePinnedBrowserOrigin("browser:ctx1", closed)).toBeNull();
  });
});
