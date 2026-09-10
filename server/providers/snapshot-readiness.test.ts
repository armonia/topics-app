/** @covers MP-TASK-02, MP-API-01 */
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { CodexProvider } from "./codex";
import { getDefaultProviderName, registerProvider, removeProvider, setDefaultProvider } from "./index";
import { ProviderSnapshotManager } from "./snapshot-manager";
import type { ProviderDiagnostic } from "./types";
import { availableTaskModels, taskProviderForModel } from "../../shared/task-coding-models";

const codingModel = "gpt-test";
const ready: ProviderDiagnostic = { name: "codex", status: "ready", requirements: [] };
const restore: Array<() => void> = [];

afterEach(() => {
  removeProvider("codex");
  for (const undo of restore.splice(0).reverse()) undo();
  setSystemTime();
});

function setup() {
  setSystemTime(new Date("2026-09-08T10:00:00Z"));
  // Register the real provider object while keeping startup and probes inert.
  const start = spyOn(CodexProvider.prototype, "start").mockImplementation(() => {});
  const provider = registerProvider({ type: "codex" });
  start.mockRestore();
  const previousDefault = getDefaultProviderName();
  if (previousDefault && previousDefault !== "codex") restore.push(() => setDefaultProvider(previousDefault));
  setDefaultProvider("codex");
  const diagnose = spyOn(provider, "diagnose").mockResolvedValue(ready);
  const models = spyOn(provider, "listModels").mockResolvedValue([codingModel]);
  const effort = spyOn(provider, "effortTier").mockReturnValue("medium");
  restore.push(() => diagnose.mockRestore(), () => models.mockRestore(), () => effort.mockRestore());
  const manager = new ProviderSnapshotManager();
  return { diagnose, models, manager };
}

test("an expired ready snapshot remains routable during one shared refresh", async () => {
  const { diagnose, models, manager } = setup();
  await manager.refresh("codex");
  const initial = manager.getSnapshot().providers.find(p => p.name === "codex")!;
  let finish!: (value: ProviderDiagnostic) => void;
  diagnose.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  models.mockResolvedValue(["gpt-next"]);
  setSystemTime(new Date("2026-09-08T10:05:01Z"));

  const refreshing = manager.getSnapshot();
  const pending = manager.refresh("codex");
  const current = refreshing.providers.find(p => p.name === "codex")!;
  expect(current.status).toBe("ready");
  expect(current.fetchedAt).toBe(initial.fetchedAt);
  expect(availableTaskModels(refreshing)).toContain(codingModel);
  expect(taskProviderForModel(undefined, refreshing)).toBe("codex");
  expect(taskProviderForModel("codex", manager.getSnapshot())).toBe("codex");
  expect(diagnose).toHaveBeenCalledTimes(2);

  finish(ready);
  await pending;
  const refreshed = manager.getSnapshot().providers.find(p => p.name === "codex")!;
  expect(refreshed.models).toEqual(["gpt-next"]);
  expect(refreshed.fetchedAt).not.toBe(initial.fetchedAt);
});

test("a failed replacement diagnostic revokes the prior ready state", async () => {
  const { diagnose, manager } = setup();
  await manager.refresh("codex");
  let reject!: (error: Error) => void;
  diagnose.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = manager.refresh("codex");
  expect(taskProviderForModel("codex", manager.getSnapshot())).toBe("codex");
  reject(new Error("credential rejected"));
  await pending;
  const snapshot = manager.getSnapshot();
  expect(snapshot.providers.find(p => p.name === "codex")?.status).toBe("error");
  expect(() => taskProviderForModel("codex", snapshot)).toThrow("Codex is unavailable");
  expect(availableTaskModels(snapshot)).not.toContain(codingModel);
});

test("first discovery and credential invalidation remain pending until verified", async () => {
  const { diagnose, manager } = setup();
  for (const phase of ["boot", "replacement"]) {
    if (phase === "replacement") manager.invalidate("codex");
    let finish!: (value: ProviderDiagnostic) => void;
    diagnose.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const snapshot = manager.getSnapshot();
    const pending = manager.refresh("codex");
    expect(snapshot.providers.find(p => p.name === "codex")?.status).toBe("loading");
    for (const selection of [undefined, "codex", codingModel]) {
      let failure: unknown;
      try { taskProviderForModel(selection, snapshot); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "task_provider_pending", provider: "codex" });
    }
    finish(ready);
    await pending;
    expect(taskProviderForModel("codex", manager.getSnapshot())).toBe("codex");
  }
});
