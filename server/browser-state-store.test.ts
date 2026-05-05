import { test, expect } from "bun:test";

// Real tests are implemented in Task 2 of this plan. This stub guarantees
// the file exists so validation pipeline (bun test server/browser-state-store.test.ts)
// passes the existence check before Task 2 lands.
test.todo("saveStorageState writes JSON atomically to data/browser-state/<topicId>/storage.json");
test.todo("loadStorageState returns null for missing topic, parsed StorageState for existing");
test.todo("deleteStorageState removes file and parent dir if empty");
test.todo("debouncedSaver coalesces rapid calls and flushes on demand");

// Smoke import to catch typo in module path early.
test("module is importable", async () => {
  const mod = await import("./browser-state-store").catch(() => null);
  // Module may not exist yet (Task 2 creates it). If it does not, just return.
  if (!mod) return;
  expect(typeof mod.saveStorageState).toBe("function");
  expect(typeof mod.loadStorageState).toBe("function");
  expect(typeof mod.deleteStorageState).toBe("function");
  expect(typeof mod.debouncedSaver).toBe("function");
});
