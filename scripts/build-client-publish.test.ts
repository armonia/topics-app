/**
 * @covers LAND-11
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingBundleAssets, unreachableAssets } from "../server/lib/client-bundle";
import { publishBundle, referencedAssets, SWEEP_MIN_AGE_MS, walk } from "./build-client-publish";

/** Push a file's mtime back: elapsed wall clock, without the wait. */
function age(file: string, ms: number): void {
  const t = (statSync(file).mtimeMs - ms) / 1000;
  utimesSync(file, t, t);
}

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
    // The bundle the previous index.html pointed at was written seconds ago,
    // so the grace window keeps it: the page loaded just before the flip goes
    // on working.
    expect(existsSync(join(pub, "assets", "index-old.js"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a lazy chunk of THIS build is not swept, however old it is", () => {
    const root = scratch();
    const staging = join(root, "staging");
    const pub = join(root, "public");
    bundle(staging, "index-new.js", "index-new.css");
    // index.html names nobody: only the entry chunk imports it.
    writeFileSync(join(staging, "assets", "index-new.js"), 'import("./lazy-new.js")');
    writeFileSync(join(staging, "assets", "lazy-new.js"), "export default 1");

    publishBundle(staging, pub);
    const lazy = join(pub, "assets", "lazy-new.js");
    age(lazy, SWEEP_MIN_AGE_MS + 60_000);
    // A second publish of the same bundle: the chunk is now older than the
    // window, and it is still part of what index.html reaches.
    const res = publishBundle(staging, pub);
    expect(existsSync(lazy)).toBe(true);
    expect(res.swept).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("three builds a grace window apart leave ZERO stale orphans", () => {
    const root = scratch();
    const pub = join(root, "public");
    const round = (n: number): string => {
      const staging = join(root, `staging-${n}`);
      bundle(staging, `index-${n}.js`, `index-${n}.css`);
      writeFileSync(join(staging, "assets", `index-${n}.js`), `import("./lazy-${n}.js")`);
      writeFileSync(join(staging, "assets", `lazy-${n}.js`), "export default 1");
      return staging;
    };
    for (let n = 1; n <= 3; n++) {
      expect(publishBundle(round(n), pub).broken).toBeNull();
      // The window expires between one round and the next: shifting every
      // mtime back is the same thing as waiting, without waiting 30 minutes.
      if (n < 3) for (const f of walk(join(pub, "assets"))) age(join(pub, "assets", f), SWEEP_MIN_AGE_MS + 60_000);
    }

    // The bar of the card: files public/assets holds, that index.html does not
    // reach, older than the sweep window.
    const now = Date.now();
    const reachable = new Set(walk(join(pub, "assets")));
    for (const orphan of unreachableAssets(join(pub, "assets"), referencedAssets(join(pub, "index.html")))) {
      reachable.delete(orphan);
    }
    const stale = walk(join(pub, "assets")).filter(
      (f) => !reachable.has(f) && now - statSync(join(pub, "assets", f)).mtimeMs >= SWEEP_MIN_AGE_MS,
    );
    expect(stale).toEqual([]);
    // And what is left is exactly the last build, nothing else.
    expect(walk(join(pub, "assets")).sort()).toEqual(["index-3.css", "index-3.js", "lazy-3.js"]);
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
