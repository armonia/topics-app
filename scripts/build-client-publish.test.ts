/**
 * @covers LAND-11
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingBundleAssets } from "../server/lib/client-bundle";
import { publishBundle, SWEEP_MIN_AGE_MS } from "./build-client-publish";

const html = (js: string, css: string) =>
  `<!doctype html><html><head><script type="module" src="/assets/${js}"></script>` +
  `<link rel="stylesheet" href="/assets/${css}"></head><body></body></html>\n`;

function bundle(dir: string, js: string, css: string): void {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", js), "export default 1");
  writeFileSync(join(dir, "assets", css), "body{}");
  writeFileSync(join(dir, "index.html"), html(js, css));
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "publish-"));
}

describe("publishBundle", () => {
  test("publishes into an empty directory", () => {
    const root = scratch();
    const staging = join(root, "staging");
    const pub = join(root, "public");
    bundle(staging, "index-new.js", "index-new.css");
    writeFileSync(join(staging, "sw.js"), "// service worker");

    const res = publishBundle(staging, pub);
    expect(res.broken).toBeNull();
    expect(missingBundleAssets(pub)).toEqual([]);
    expect(existsSync(join(pub, "sw.js"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("the old bundle stays whole until the flip, and the flip is one file", () => {
    const root = scratch();
    const staging = join(root, "staging");
    const pub = join(root, "public");
    bundle(pub, "index-old.js", "index-old.css");
    bundle(staging, "index-new.js", "index-new.css");

    publishBundle(staging, pub);
    // The new entry is live, and the old chunks are still on disk: a page
    // loaded a second before the flip keeps working instead of 404ing.
    expect(readFileSync(join(pub, "index.html"), "utf8")).toContain("index-new.js");
    expect(existsSync(join(pub, "assets", "index-old.js"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a stale asset from an old session is swept, a fresh one is not", () => {
    const root = scratch();
    const staging = join(root, "staging");
    const pub = join(root, "public");
    bundle(pub, "index-old.js", "index-old.css");
    const ancient = join(pub, "assets", "chunk-ancient.js");
    writeFileSync(ancient, "old");
    const old = (Date.now() - SWEEP_MIN_AGE_MS - 60_000) / 1000;
    utimesSync(ancient, old, old);
    // Another build in flight just wrote its own chunk here.
    writeFileSync(join(pub, "assets", "chunk-parallel.js"), "fresh");
    bundle(staging, "index-new.js", "index-new.css");

    const res = publishBundle(staging, pub);
    expect(res.swept).toBe(1);
    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(join(pub, "assets", "chunk-parallel.js"))).toBe(true);
    // The bundle the previous index.html pointed at is never swept in the same
    // run that replaced it.
    expect(existsSync(join(pub, "assets", "index-old.js"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("says it when what got published is not servable", () => {
    const root = scratch();
    const staging = join(root, "staging");
    const pub = join(root, "public");
    mkdirSync(staging, { recursive: true });
    // index.html referencing an asset the build never wrote: the 29/08 shape.
    writeFileSync(join(staging, "index.html"), html("index-ghost.js", "index-ghost.css"));

    const res = publishBundle(staging, pub);
    expect(res.broken).toContain("index-ghost.js");
    rmSync(root, { recursive: true, force: true });
  });
});
