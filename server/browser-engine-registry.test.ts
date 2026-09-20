/**
 * @covers ENGREG-01
 */
import { describe, it, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBrowserEngineRegistry,
  type EngineSidecar,
} from "./browser-engine-registry";
import type { SidecarHandle } from "./browser-chromium-sidecar";

/** A fake sidecar that counts acquire/release and hands out distinct endpoints. */
function fakeSidecar(opts: { failAcquire?: boolean } = {}) {
  let refCount = 0;
  let acquires = 0;
  let releases = 0;
  const sidecar: EngineSidecar = {
    async acquire(): Promise<SidecarHandle> {
      if (opts.failAcquire) throw new Error("no chromium installed");
      acquires++;
      refCount++;
      return {
        cdpEndpoint: `ws://127.0.0.1:19333/devtools/browser/${acquires}`,
        engine: { id: "chrome", name: "Google Chrome", executablePath: "/x/chrome" },
      };
    },
    release(): void {
      releases++;
      refCount = Math.max(0, refCount - 1);
    },
  };
  return {
    sidecar,
    get refCount() { return refCount; },
    get acquires() { return acquires; },
    get releases() { return releases; },
  };
}

test("defaults unknown contexts to the native engine", () => {
  const { sidecar } = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar });
  expect(reg.getEngine("ctx-1")).toBe("native");
  expect(reg.size()).toBe(0);
});

test("switching to chromium acquires exactly one ref and returns the CDP endpoint", async () => {
  const fake = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  const state = await reg.setEngine("ctx-1", "chromium");
  expect(state.engine).toBe("chromium");
  expect(state.cdpEndpoint).toContain("ws://127.0.0.1:19333/devtools/browser/");
  expect(fake.acquires).toBe(1);
  expect(fake.refCount).toBe(1);
  expect(reg.getEngine("ctx-1")).toBe("chromium");
  expect(reg.listChromium()).toEqual(["ctx-1"]);
});

test("setting the same engine twice is idempotent — no ref churn", async () => {
  const fake = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  const first = await reg.setEngine("ctx-1", "chromium");
  const again = await reg.setEngine("ctx-1", "chromium");
  expect(fake.acquires).toBe(1); // NOT 2
  expect(fake.refCount).toBe(1);
  expect(again.cdpEndpoint).toBe(first.cdpEndpoint);
});

test("switching back to native releases the one ref the pane held", async () => {
  const fake = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  await reg.setEngine("ctx-1", "chromium");
  const state = await reg.setEngine("ctx-1", "native");
  expect(state.engine).toBe("native");
  expect(state.cdpEndpoint).toBeUndefined();
  expect(fake.releases).toBe(1);
  expect(fake.refCount).toBe(0);
  expect(reg.listChromium()).toEqual([]);
});

test("redundant native→native does not release (never goes negative)", async () => {
  const fake = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  await reg.setEngine("ctx-1", "native"); // already native
  expect(fake.releases).toBe(0);
  expect(fake.refCount).toBe(0);
});

test("release() drops a chromium pane's ref; native/unknown release is a no-op", async () => {
  const fake = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  await reg.setEngine("ctx-1", "chromium");
  await reg.setEngine("ctx-2", "chromium");
  reg.release("ctx-1");
  expect(fake.releases).toBe(1);
  expect(fake.refCount).toBe(1);
  expect(reg.listChromium()).toEqual(["ctx-2"]);
  reg.release("ctx-native"); // unknown → no-op
  reg.release("ctx-1"); // already released → no-op
  expect(fake.releases).toBe(1);
});

test("two panes on chromium hold two independent refs", async () => {
  const fake = fakeSidecar();
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  await reg.setEngine("a", "chromium");
  await reg.setEngine("b", "chromium");
  expect(fake.refCount).toBe(2);
  expect(reg.listChromium().sort()).toEqual(["a", "b"]);
  reg.release("a");
  reg.release("b");
  expect(fake.refCount).toBe(0);
});

test("a failed cold start leaves the pane native and holds no ref", async () => {
  const fake = fakeSidecar({ failAcquire: true });
  const reg = createBrowserEngineRegistry({ sidecar: fake.sidecar });
  await expect(reg.setEngine("ctx-1", "chromium")).rejects.toThrow("no chromium installed");
  expect(reg.getEngine("ctx-1")).toBe("native");
  expect(fake.refCount).toBe(0);
  expect(reg.listChromium()).toEqual([]);
});

describe("the registry does not quote numbers that stopped being true", () => {
  it("no wait time HARDCODED into the sidecar message", () => {
    // FOUND IN THE PRODUCT, not by reading the code: starting the real
    // sidecar, the log said "il CDP si aspetta 10s" when the base was already  allow-italian: the quoted log line IS the subject
    // 30. A message quoting a wrong number is worse than no message: the next
    // person to read it reasons on top of it.
    //
    // This does not check the wording, it checks that the wording carries no
    // wait seconds SEWN into the source: if they are there, they will lie.
    const src = readFileSync(join(import.meta.dir, "browser-engine-registry.ts"), "utf-8");
    const line = src.split("\n").find((l) => l.includes("il CDP aspetta"));
    expect(line).toBeDefined();
    // It has to interpolate the constant, not spell the number out.
    expect(line).toContain("CDP_WAIT_BASE_MS");
    expect(line).not.toMatch(/aspetta \d+s/);
  });
});
