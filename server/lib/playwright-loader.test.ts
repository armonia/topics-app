import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaywrightLoader, PLAYWRIGHT_CORE_RANGE } from "./playwright-loader";

const missing = () => Promise.reject(new Error("Cannot find package 'playwright-core' from server"));

describe("playwright loader", () => {
  it("keeps its range equal to package.json", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json();
    expect(pkg.dependencies["playwright-core"]).toBe(PLAYWRIGHT_CORE_RANGE);
  });

  it("does not install when the plain import works", async () => {
    let installs = 0;
    const load = createPlaywrightLoader({
      importDefault: async () => ({ ok: 1 }) as never,
      install: async () => { installs += 1; return 0; },
    });
    expect(await load()).toEqual({ ok: 1 } as never);
    expect(installs).toBe(0);
  });

  it("installs once and loads from the data dir when the package is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwl-"));
    try {
      let installs = 0;
      const load = createPlaywrightLoader({
        importDefault: missing,
        depsDir: dir,
        log: () => {},
        install: async (d) => {
          installs += 1;
          mkdirSync(join(d, "node_modules", "playwright-core"), { recursive: true });
          writeFileSync(join(d, "node_modules", "playwright-core", "index.js"), "");
          return 0;
        },
        importFrom: async (url) => ({ url }) as never,
      });
      const [a, b] = await Promise.all([load(), load()]);
      expect((a as never as { url: string }).url).toContain("playwright-core/index.js");
      expect(b).toBe(a);
      expect(installs).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails with a clear message when the install fails, and retries next time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwl-"));
    try {
      let installs = 0;
      const load = createPlaywrightLoader({
        importDefault: missing, depsDir: dir, log: () => {},
        install: async () => { installs += 1; return 1; },
      });
      await expect(load()).rejects.toThrow(/automatic install failed/);
      await expect(load()).rejects.toThrow(/automatic install failed/);
      expect(installs).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
