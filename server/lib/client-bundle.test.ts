/**
 * @covers LAND-10
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleBreakageReason, missingBundleAssets, unreachableAssets } from "./client-bundle";

function bundleDir(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-check-"));
  build(dir);
  return dir;
}

const HTML = (assets: string[]) =>
  `<!doctype html><html><head>${assets
    .map((a) => (a.endsWith(".css") ? `<link rel="stylesheet" href="${a}">` : `<script type="module" src="${a}"></script>`))
    .join("")}</head><body><div id="root"></div></body></html>\n`;

function whole(dir: string): void {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "index-aaa.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "index-bbb.css"), "body{}");
  writeFileSync(join(dir, "index.html"), HTML(["/assets/index-aaa.js", "/assets/index-bbb.css"]));
}

describe("missingBundleAssets", () => {
  test("a complete bundle reports nothing missing", () => {
    const dir = bundleDir(whole);
    expect(missingBundleAssets(dir)).toEqual([]);
    expect(bundleBreakageReason(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the state of 29/08: assets emptied, index.html gone", () => {
    const dir = bundleDir((d) => mkdirSync(join(d, "assets"), { recursive: true }));
    expect(missingBundleAssets(dir)).toEqual(["index.html"]);
    expect(bundleBreakageReason(dir)).toContain("index.html");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a zero byte index.html is not a bundle", () => {
    const dir = bundleDir((d) => writeFileSync(join(d, "index.html"), ""));
    expect(missingBundleAssets(dir)).toEqual(["index.html (empty)"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an index.html cut mid write is not a bundle", () => {
    const dir = bundleDir((d) => writeFileSync(join(d, "index.html"), "<!doctype html><html><head>"));
    expect(missingBundleAssets(dir)).toEqual(["index.html (truncated)"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("index.html without a JS entry is a blank page", () => {
    const dir = bundleDir((d) => writeFileSync(join(d, "index.html"), HTML(["/assets/index-bbb.css"])));
    expect(missingBundleAssets(dir)).toEqual(["index.html (no /assets/*.js entry)"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a referenced asset that is not on disk is named", () => {
    const dir = bundleDir((d) => {
      whole(d);
      rmSync(join(d, "assets", "index-bbb.css"));
    });
    expect(missingBundleAssets(dir)).toEqual(["/assets/index-bbb.css"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("unreachableAssets", () => {
  const assets = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "reach-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return dir;
  };

  test("follows lazy imports: a chunk index.html never names is not an orphan", () => {
    const dir = assets({
      "index-aaa.js": 'import("./lazy-bbb.js")',
      "lazy-bbb.js": "export default 1",
      "leftover-ccc.js": "export default 2",
    });
    expect(unreachableAssets(dir, ["/assets/index-aaa.js"])).toEqual(["leftover-ccc.js"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("follows a font cited by a CSS url()", () => {
    const dir = assets({
      "index-aaa.js": "export default 1",
      "index-aaa.css": "@font-face{src:url(/assets/inter-ddd.woff2)}",
      "inter-ddd.woff2": "not really a font",
    });
    expect(unreachableAssets(dir, ["assets/index-aaa.js", "assets/index-aaa.css"])).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a cycle between two chunks does not hang the walk", () => {
    const dir = assets({
      "a-1.js": 'import("./b-2.js")',
      "b-2.js": 'import("./a-1.js")',
    });
    expect(unreachableAssets(dir, ["a-1.js"])).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no roots at all: everything on disk is unreachable", () => {
    const dir = assets({ "a-1.js": "export default 1", "sub/b-2.js": "export default 2" });
    expect(unreachableAssets(dir, [])).toEqual(["a-1.js", "sub/b-2.js"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a directory that is not there gives no orphans, not an exception", () => {
    expect(unreachableAssets(join(tmpdir(), "reach-nope-9999"), ["a.js"])).toEqual([]);
  });
});
