/** @covers LAND-11 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const BUILD_PROCESS_TIMEOUT_MS = 30_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "topics-build-args-"));
  roots.push(root);
  const repo = join(root, "checkout");
  for (const file of ["scripts/build-client.ts", "scripts/build-client-publish.ts", "server/lib/client-bundle.ts", "server/lib/real-path.ts", "server/lib/path-containment.ts"]) {
    const target = join(repo, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(import.meta.dir, "..", file), target);
  }
  const source = join(repo, "client", "source.ts");
  const published = join(repo, "public", "index.html");
  const started = join(root, "builder-started");
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(published), { recursive: true });
  writeFileSync(source, "source must survive");
  writeFileSync(published, "previous bundle must survive");
  const bins = join(repo, "client", "node_modules", ".bin");
  mkdirSync(bins, { recursive: true });
  // Only the compiler and bundler are fakes. The CLI, argument validation,
  // bundle verification and publication all execute their real source.
  writeFileSync(join(bins, "tsc"), `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started');`);
  writeFileSync(join(bins, "vite"), `
    const { mkdirSync, writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const out = process.argv[process.argv.indexOf('--outDir') + 1];
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'assets', 'index-test.js'), 'export default 1;');
    writeFileSync(join(out, 'index.html'), '<html><script type="module" src="/assets/index-test.js"></script></html>');
  `);
  return {
    root, repo, source, published, started,
    run(args: string[], cwd = repo) {
      return spawnSync(process.execPath, [join(repo, "scripts", "build-client.ts"), ...args], {
        cwd, encoding: "utf8", timeout: BUILD_PROCESS_TIMEOUT_MS,
      });
    },
  };
}

describe("build client CLI preserves the checkout on invalid output arguments", () => {
  for (const args of [["--out"], ["--out", ""], ["--out", "   "], ["--out", "--watch"], ["--wat"], ["--out", "../bundle", "--out", "../another"]]) {
    test(`rejects ${JSON.stringify(args)} before starting a builder`, () => {
      const f = fixture();
      const result = f.run(args);
      expect(existsSync(f.source)).toBe(true);
      expect(readFileSync(f.published, "utf8")).toBe("previous bundle must survive");
      expect(existsSync(f.started)).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--out");
    });
  }

  for (const target of [".", "..", "client", "public", "client/new-output"]) {
    test(`rejects output overlapping the checkout: ${target}`, () => {
      const f = fixture();
      const result = f.run(["--out", target]);
      expect(existsSync(f.source)).toBe(true);
      expect(readFileSync(f.published, "utf8")).toBe("previous bundle must survive");
      expect(existsSync(f.started)).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("outside the checkout");
    });
  }

  test("resolves symlinks before accepting an output directory", () => {
    const f = fixture();
    const alias = join(f.root, "alias");
    symlinkSync(f.repo, alias, process.platform === "win32" ? "junction" : "dir");
    const result = f.run(["--out", join(alias, "client", "new-output")]);
    expect(existsSync(f.source)).toBe(true);
    expect(existsSync(f.started)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the checkout");
  });

  test("rejects a missing value when called from client too", () => {
    const f = fixture();
    const result = f.run(["--out"], join(f.repo, "client"));
    expect(existsSync(f.source)).toBe(true);
    expect(existsSync(f.started)).toBe(false);
    expect(result.status).toBe(1);
  });

  test("builds a new external output and replaces only that output on a second run", () => {
    const f = fixture();
    const out = join(f.root, "external", "bundle");
    expect(f.run(["--out", out]).status).toBe(0);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("index-test.js");
    writeFileSync(join(out, "stale.js"), "old bundle");
    expect(f.run(["--out", out]).status).toBe(0);
    expect(existsSync(join(out, "stale.js"))).toBe(false);
    expect(readFileSync(f.published, "utf8")).toBe("previous bundle must survive");
    expect(existsSync(f.source)).toBe(true);
  });

  test("without arguments publishes a verified bundle through staging", () => {
    const f = fixture();
    expect(f.run([]).status).toBe(0);
    expect(readFileSync(f.published, "utf8")).toContain("index-test.js");
    expect(existsSync(f.source)).toBe(true);
  });
});
