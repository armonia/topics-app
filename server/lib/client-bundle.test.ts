/**
 * @covers LAND-10
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleBreakageReason, missingBundleAssets } from "./client-bundle";

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
