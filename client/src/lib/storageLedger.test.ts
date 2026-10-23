/**
 * Ledger of refused localStorage writes: the quota is full, callers swallow
 * the error, and nobody counts. These tests pin the counting.
 *
 * @covers QUOTA-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  getStorageDiscards,
  installStorageLedger,
  measureStorageUsage,
  resetStorageLedgerForTests,
  subscribeStorageDiscards,
} from "./storageLedger";

class FakeStorage {
  data = new Map<string, string>();
  failWith: unknown = null;
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWith) throw this.failWith;
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

const globals = globalThis as Record<string, unknown>;
const realWarn = console.warn;
let warnings: string[] = [];

function setupLedger(): FakeStorage {
  const store = new FakeStorage();
  globals.Storage = FakeStorage;
  globals.localStorage = store;
  warnings = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  installStorageLedger();
  return store;
}

afterEach(() => {
  resetStorageLedgerForTests();
  console.warn = realWarn;
  delete globals.Storage;
  delete globals.localStorage;
  delete globals.sessionStorage;
});

function quotaError(): Error {
  return Object.assign(new Error("quota full"), { name: "QuotaExceededError" });
}

describe("storage ledger", () => {
  test("counts a quota error and rethrows the same object", () => {
    const store = setupLedger();
    const boom = quotaError();
    store.failWith = boom;
    let caught: unknown = null;
    try {
      store.setItem("messages-cache-abc", "x".repeat(10));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
    const snapshot = getStorageDiscards();
    expect(snapshot.total).toBe(1);
    expect(snapshot.quota).toBe(1);
    expect(snapshot.keys).toHaveLength(1);
    expect(snapshot.keys[0]).toMatchObject({
      key: "messages-cache-*",
      quota: 1,
      denied: 0,
      lastChars: 10,
      userData: false,
    });
    expect(snapshot.keys[0]?.lastAt).toBeGreaterThan(0);
  });

  test("code 22 and the Firefox quota name count as quota too", () => {
    const store = setupLedger();
    store.failWith = Object.assign(new Error("full"), { code: 22 });
    expect(() => store.setItem("a", "1")).toThrow();
    store.failWith = Object.assign(new Error("full"), { name: "NS_ERROR_DOM_QUOTA_REACHED" });
    expect(() => store.setItem("b", "2")).toThrow();
    expect(getStorageDiscards().quota).toBe(2);
    expect(getStorageDiscards().total).toBe(2);
  });

  test("any other error counts as denied, not quota", () => {
    const store = setupLedger();
    store.failWith = Object.assign(new Error("blocked"), { name: "SecurityError" });
    expect(() => store.setItem("k", "v")).toThrow();
    const snapshot = getStorageDiscards();
    expect(snapshot.total).toBe(1);
    expect(snapshot.quota).toBe(0);
    expect(snapshot.keys[0]).toMatchObject({ denied: 1 });
  });

  test("warns only once per folded key", () => {
    const store = setupLedger();
    store.failWith = quotaError();
    for (let i = 0; i < 3; i++) {
      try {
        store.setItem("messages-cache-topic-1", "v");
      } catch {
        // The caller swallows it, the ledger only counts.
      }
    }
    try {
      store.setItem("board-rows-p1", "v");
    } catch {
      // Same swallow as the callers in the app.
    }
    expect(warnings).toHaveLength(2);
    expect(getStorageDiscards().keys.find((row) => row.key === "messages-cache-*")?.quota).toBe(3);
  });

  test("userData flag comes from a real undelivered-message prefix", () => {
    const store = setupLedger();
    store.failWith = quotaError();
    try {
      store.setItem("messages-outbound-queue", "[{}]");
    } catch {
      // Swallowed like the queue writer does.
    }
    const snapshot = getStorageDiscards();
    expect(snapshot.keys[0]).toMatchObject({ userData: true });
    expect(snapshot.userData).toBe(1);
  });

  test("snapshot reference is stable without change and new after a change", () => {
    const store = setupLedger();
    const first = getStorageDiscards();
    expect(getStorageDiscards()).toBe(first);
    store.failWith = quotaError();
    try {
      store.setItem("k", "v");
    } catch {
      // Swallowed like the callers do.
    }
    const second = getStorageDiscards();
    expect(second).not.toBe(first);
    expect(getStorageDiscards()).toBe(second);
    expect(second.keys.map((row) => row.key)).toEqual(["k"]);
  });

  test("keys sort by quota plus denied descending", () => {
    const store = setupLedger();
    store.failWith = quotaError();
    const fail = (key: string): void => {
      try {
        store.setItem(key, "v");
      } catch {
        // Swallowed like the callers do.
      }
    };
    fail("rare-key");
    fail("hot-key");
    fail("hot-key");
    fail("mid-key");
    fail("mid-key");
    fail("hot-key");
    expect(getStorageDiscards().keys.map((row) => row.key)).toEqual(["hot-key", "mid-key", "rare-key"]);
  });

  test("install is idempotent: two installs wrap once", () => {
    const store = setupLedger();
    const wrapped = (globals.Storage as typeof FakeStorage).prototype.setItem;
    installStorageLedger();
    expect((globals.Storage as typeof FakeStorage).prototype.setItem).toBe(wrapped);
    store.failWith = quotaError();
    try {
      store.setItem("k", "v");
    } catch {
      // Swallowed like the callers do.
    }
    expect(getStorageDiscards().total).toBe(1);
  });

  test("successful writes are not counted and notify nobody", () => {
    const store = setupLedger();
    const before = getStorageDiscards();
    let calls = 0;
    const stop = subscribeStorageDiscards(() => {
      calls += 1;
    });
    try {
      store.setItem("draft:topic-1", "hello");
      expect(store.getItem("draft:topic-1")).toBe("hello");
    } finally {
      stop();
    }
    expect(calls).toBe(0);
    expect(warnings).toHaveLength(0);
    expect(getStorageDiscards()).toBe(before);
    expect(before.total).toBe(0);
  });

  test("a refused write notifies subscribers synchronously", () => {
    const store = setupLedger();
    let calls = 0;
    const stop = subscribeStorageDiscards(() => {
      calls += 1;
    });
    try {
      store.failWith = quotaError();
      try {
        store.setItem("k", "v");
      } catch {
        // Swallowed like the callers do.
      }
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  test("writes on other storage instances are ignored", () => {
    setupLedger();
    const other = new FakeStorage();
    globals.sessionStorage = other;
    other.failWith = quotaError();
    expect(() => other.setItem("k", "v")).toThrow();
    expect(getStorageDiscards().total).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test("measureStorageUsage counts UTF-16 bytes over localStorage", () => {
    const store = setupLedger();
    store.data.set("ab", "cde");
    store.data.set("xy", "z");
    expect(measureStorageUsage()).toEqual({
      usedBytes: 2 * (2 + 3) + 2 * (2 + 1),
      limitBytes: 5 * 1024 * 1024,
    });
  });

  test("measureStorageUsage reports zeros without storage", () => {
    setupLedger();
    delete globals.localStorage;
    expect(measureStorageUsage()).toEqual({ usedBytes: 0, limitBytes: 5 * 1024 * 1024 });
  });

  test("reset restores the original setItem and clears counters", () => {
    const pristine = FakeStorage.prototype.setItem;
    const store = setupLedger();
    expect((globals.Storage as typeof FakeStorage).prototype.setItem).not.toBe(pristine);
    store.failWith = quotaError();
    try {
      store.setItem("k", "v");
    } catch {
      // Swallowed like the callers do.
    }
    expect(getStorageDiscards().total).toBe(1);
    resetStorageLedgerForTests();
    expect((globals.Storage as typeof FakeStorage).prototype.setItem).toBe(pristine);
    expect(getStorageDiscards().total).toBe(0);
    expect(getStorageDiscards().keys).toHaveLength(0);
  });
});
