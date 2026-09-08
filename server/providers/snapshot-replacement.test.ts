/** @covers MP-API-01 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { registerProvider, removeProvider } from "./index";
import { ProviderSnapshotManager } from "./snapshot-manager";
import type { ProviderDiagnostic } from "./types";

afterEach(() => removeProvider("openai"));

test("an old auth probe cannot overwrite a connection after credential replacement", async () => {
  const provider = registerProvider({ type: "openai", apiKey: "test-only" });
  let oldReply!: (value: ProviderDiagnostic) => void;
  const diagnose = spyOn(provider, "diagnose").mockImplementationOnce(() => new Promise((resolve) => { oldReply = resolve; }));
  const models = spyOn(provider, "listModels").mockResolvedValue(["gpt-4o"]);
  const manager = new ProviderSnapshotManager();
  try {
    const stale = manager.refresh("openai");
    manager.invalidate("openai");
    diagnose.mockResolvedValue({ name: "openai", status: "ready", requirements: [] });
    await manager.refresh("openai");
    expect(manager.getSnapshot().providers[0]?.status).toBe("ready");
    oldReply({ name: "openai", status: "error", requirements: [], lastError: "old key rejected" });
    await stale;
    expect(manager.getSnapshot().providers[0]?.status).toBe("ready");
    expect(manager.getSnapshot().providers[0]?.lastError).toBeUndefined();
    expect(diagnose).toHaveBeenCalledTimes(2);
  } finally { diagnose.mockRestore(); models.mockRestore(); }
});
