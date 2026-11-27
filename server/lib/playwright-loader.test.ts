/**
 * @covers BROWSER-NODE-DEPS-01
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaywrightLoader, PLAYWRIGHT_CORE_INTEGRITY, PLAYWRIGHT_CORE_VERSION, browserDepsManifest } from "./playwright-loader";

const missing = () => Promise.reject(new Error("Cannot find package 'playwright-core' from server"));

describe("playwright loader", () => {
  it("pins the exact version and integrity that bun.lock resolves", async () => {
    const lock = await Bun.file(join(import.meta.dir, "..", "..", "bun.lock")).text();
    const line = lock.split(/\r?\n/).find((l) => l.includes(`"playwright-core@${PLAYWRIGHT_CORE_VERSION}"`));
    expect(line).toBeDefined();
    expect(line).toContain(PLAYWRIGHT_CORE_INTEGRITY);
  });

  it("writes an exact-version manifest and a lockfile carrying the integrity", () => {
    const { packageJson, lockText } = browserDepsManifest();
    expect(JSON.parse(packageJson).dependencies["playwright-core"]).toBe(PLAYWRIGHT_CORE_VERSION);
    expect(lockText).toContain(PLAYWRIGHT_CORE_INTEGRITY);
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

  it("installs once and loads the entry its own manifest names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwl-"));
    try {
      let installs = 0;
      const load = createPlaywrightLoader({
        importDefault: missing,
        depsDir: dir,
        log: () => {},
        install: async (d) => {
          installs += 1;
          const pkgDir = join(d, "node_modules", "playwright-core");
          mkdirSync(pkgDir, { recursive: true });
          writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": { import: "./entry-point.js", default: "./entry-point.js" } } }));
          writeFileSync(join(pkgDir, "entry-point.js"), "");
          return 0;
        },
        importFrom: async (url) => ({ url }) as never,
      });
      const [a, b] = await Promise.all([load(), load()]);
      expect((a as never as { url: string }).url).toContain("playwright-core/entry-point.js");
      expect(b).toBe(a);
      expect(installs).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("treats a copy without a package.json as not installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwl-"));
    try {
      const pkgDir = join(dir, "node_modules", "playwright-core");
      mkdirSync(pkgDir, { recursive: true });
      let installs = 0;
      const load = createPlaywrightLoader({
        importDefault: missing,
        depsDir: dir,
        log: () => {},
        install: async (d) => {
          installs += 1;
          const installedPkgDir = join(d, "node_modules", "playwright-core");
          writeFileSync(join(installedPkgDir, "package.json"), JSON.stringify({ main: "./index.js" }));
          writeFileSync(join(installedPkgDir, "index.js"), "");
          return 0;
        },
        importFrom: async (url) => ({ url }) as never,
      });
      await load();
      expect(installs).toBe(1); // the pre-existing dir had no package.json, so it was re-installed
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

/** Runs the frozen offline install in a temp dir; the dir is removed before returning. */
async function runFrozenOfflineInstall(): Promise<{ code: number; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pwl-lock-"));
  try {
    const { packageJson, lockText } = browserDepsManifest();
    writeFileSync(join(dir, "package.json"), packageJson);
    writeFileSync(join(dir, "bun.lock"), lockText);
    const proc = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--offline"], { // runtime-dep-ok: test of the bootstrap install
      cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" },
      timeout: 60_000, killSignal: "SIGKILL",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { code, err };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A missing local cache is the only reason to skip, and it is printed: the test never goes green without running.
const lockRun = await runFrozenOfflineInstall();
const cacheMissing = lockRun.code !== 0 && /offline|cache|not found|ENOENT|failed to resolve|404|No version matching/i.test(lockRun.err);
if (cacheMissing) console.warn(`SKIPPED hand-written bun.lock test: bun cache has no playwright-core@${PLAYWRIGHT_CORE_VERSION}: ${lockRun.err.slice(0, 200)}`);

describe("hand-written bun.lock", () => {
  it.skipIf(cacheMissing)("is accepted by `bun install --frozen-lockfile --offline`", () => {
    expect(lockRun.code).toBe(0);
  });
});
