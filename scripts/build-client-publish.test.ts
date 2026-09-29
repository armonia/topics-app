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
import {
  GENERATION_KEEP_COUNT,
  GENERATION_KEEP_MS,
  publishBundle,
  type PublishResult,
  referencedAssets,
  retainedAssets,
  SWEEP_MIN_AGE_MS,
  walk,
} from "./build-client-publish";

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

  test("three builds a retention period apart leave ZERO stale orphans", () => {
    const root = scratch();
    const pub = join(root, "public");
    const now = Date.now();
    // Each round is published one retention period (plus an hour) after the
    // one before: by round 3 the first one stopped being served longer ago
    // than the retention period, the second one just now.
    const step = GENERATION_KEEP_MS + 3_600_000;
    const round = (n: number): string => {
      const staging = join(root, `staging-${n}`);
      bundle(staging, `index-${n}.js`, `index-${n}.css`);
      writeFileSync(join(staging, "assets", `index-${n}.js`), `import("./lazy-${n}.js")`);
      writeFileSync(join(staging, "assets", `lazy-${n}.js`), "export default 1");
      return staging;
    };
    for (let n = 1; n <= 3; n++) {
      expect(publishBundle(round(n), pub, now - (3 - n) * step).broken).toBeNull();
      // Shifting every mtime back is the same thing as waiting, without
      // waiting three days.
      if (n < 3) for (const f of walk(pub)) age(join(pub, f), step);
    }

    // The bar of the card: files public/assets holds, that index.html does not
    // reach and no kept generation owns, older than the sweep window.
    const kept = retainedAssets(pub, now);
    const orphans = unreachableAssets(join(pub, "assets"), referencedAssets(join(pub, "index.html")));
    const stale = orphans.filter(
      (f) => !kept.has(f) && now - statSync(join(pub, "assets", f)).mtimeMs >= SWEEP_MIN_AGE_MS,
    );
    expect(stale).toEqual([]);
    // And what is left is exactly the last build and the one it replaced,
    // which windows loaded until a moment ago: nothing else.
    expect(walk(join(pub, "assets")).sort()).toEqual([
      "index-2.css",
      "index-2.js",
      "index-3.css",
      "index-3.js",
      "lazy-2.js",
      "lazy-3.js",
    ]);
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

/**
 * A desktop window keeps the index.html it loaded for as long as it stays open,
 * which is days, not the 30 minutes of the sweep window. Measured 2026-09-29:
 * the Topics.app window had been up 10h13m across 34 client commits landed on
 * main that day, and the lazy chunk of the model menu it asked for had been
 * swept, so the click 404'd and the menu never opened.
 */
describe("published generations are retained", () => {
  const HOUR = 3_600_000;

  /** A generation with an entry, a stylesheet and a lazy chunk (plus its
   *  precompressed sibling) that only the entry reaches. */
  function generation(root: string, name: string): string {
    const staging = join(root, `staging-${name}`);
    bundle(staging, `index-${name}.js`, `index-${name}.css`);
    writeFileSync(join(staging, "assets", `index-${name}.js`), `import("./menu-${name}.js")`);
    writeFileSync(join(staging, "assets", `menu-${name}.js`), "export default 1");
    writeFileSync(join(staging, "assets", `menu-${name}.js.br`), "compressed");
    return staging;
  }

  /** Every file already published, `ms` older: the clock moving on. */
  function ageAll(pub: string, ms: number): void {
    for (const f of walk(pub)) age(join(pub, f), ms);
  }

  test("an asset referenced only by a generation published 6 hours ago survives a new publish", () => {
    const root = scratch();
    const pub = join(root, "public");
    const now = Date.now();
    publishBundle(generation(root, "morning"), pub, now - 6 * HOUR);
    ageAll(pub, 6 * HOUR);

    const res = publishBundle(generation(root, "evening"), pub, now);
    expect(res.broken).toBeNull();
    // The window loaded this morning clicks the menu now: its lazy chunk, and
    // the compressed copy the server actually sends, are still there.
    expect(existsSync(join(pub, "assets", "menu-morning.js"))).toBe(true);
    expect(existsSync(join(pub, "assets", "menu-morning.js.br"))).toBe(true);
    expect(existsSync(join(pub, "assets", "index-morning.js"))).toBe(true);
    expect(readFileSync(join(pub, "index.html"), "utf8")).toContain("index-evening.js");
    expect(res.swept).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("the generation live before the first recorded publish is retained too", () => {
    const root = scratch();
    const pub = join(root, "public");
    const now = Date.now();
    // A bundle nobody recorded: published before this rule existed, or by a
    // plain `vite build` into public/. Windows can be running it all the same.
    const legacy = generation(root, "legacy");
    mkdirSync(pub, { recursive: true });
    for (const f of walk(legacy)) {
      mkdirSync(join(pub, f, ".."), { recursive: true });
      writeFileSync(join(pub, f), readFileSync(join(legacy, f)));
    }
    ageAll(pub, 6 * HOUR);

    publishBundle(generation(root, "next"), pub, now);
    expect(existsSync(join(pub, "assets", "menu-legacy.js"))).toBe(true);
    expect(existsSync(join(pub, "assets", "menu-legacy.js.br"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  /** Publish `old`, then `mid` more than a retention period later, then
   *  `new` more than a retention period after that: `old` stopped being
   *  served beyond the retention period, `mid` only now. */
  function threeGenerations(root: string, pub: string, now: number, beforeLast?: () => void): PublishResult {
    const step = GENERATION_KEEP_MS + HOUR;
    publishBundle(generation(root, "old"), pub, now - 2 * step);
    ageAll(pub, step);
    publishBundle(generation(root, "mid"), pub, now - step);
    ageAll(pub, step);
    beforeLast?.();
    return publishBundle(generation(root, "new"), pub, now);
  }

  test("an asset of a generation replaced longer ago than the retention period is swept", () => {
    const root = scratch();
    const pub = join(root, "public");
    const res = threeGenerations(root, pub, Date.now());
    expect(existsSync(join(pub, "assets", "menu-old.js"))).toBe(false);
    expect(existsSync(join(pub, "assets", "menu-old.js.br"))).toBe(false);
    expect(existsSync(join(pub, "assets", "index-old.js"))).toBe(false);
    expect(existsSync(join(pub, "assets", "index-old.css"))).toBe(false);
    expect(res.swept).toBe(4);
    // Published as long ago, but served until this publish: windows run it.
    expect(existsSync(join(pub, "assets", "menu-mid.js"))).toBe(true);
    expect(existsSync(join(pub, "assets", "menu-new.js"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("republishing the served bundle does not revive a generation it replaced long ago", () => {
    const root = scratch();
    const pub = join(root, "public");
    const now = Date.now();
    const step = GENERATION_KEEP_MS + HOUR;
    publishBundle(generation(root, "old"), pub, now - 2 * step);
    ageAll(pub, step);
    publishBundle(generation(root, "mid"), pub, now - step);
    ageAll(pub, step);
    // A land that touched only the server rebuilds the client too, and the
    // same sources give the same hashes: the same bundle, published again.
    const res = publishBundle(generation(root, "mid"), pub, now);
    expect(existsSync(join(pub, "assets", "menu-old.js"))).toBe(false);
    expect(existsSync(join(pub, "assets", "menu-mid.js"))).toBe(true);
    expect(res.swept).toBe(4);
    rmSync(root, { recursive: true, force: true });
  });

  test(`only the last ${GENERATION_KEEP_COUNT} generations are kept, however recent the others`, () => {
    const root = scratch();
    const pub = join(root, "public");
    const now = Date.now();
    // One more generation than the cap, each published a sweep window after
    // the one before: all of them well inside the retention period.
    const gap = SWEEP_MIN_AGE_MS + 60_000;
    const total = GENERATION_KEEP_COUNT + 1;
    for (let n = 0; n < total; n++) {
      const back = (total - 1 - n) * gap;
      publishBundle(generation(root, `g${n}`), pub, now - back);
      if (n < total - 1) ageAll(pub, gap);
    }
    expect(existsSync(join(pub, "assets", "menu-g0.js"))).toBe(false);
    expect(existsSync(join(pub, "assets", "menu-g1.js"))).toBe(true);
    expect(existsSync(join(pub, "assets", `menu-g${total - 1}.js`))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a build in flight is still protected while old generations are swept", () => {
    const root = scratch();
    const pub = join(root, "public");
    threeGenerations(root, pub, Date.now(), () => {
      // A second build in the same checkout has copied its chunks and not yet
      // flipped index.html: no generation names them, only their age protects
      // them.
      writeFileSync(join(pub, "assets", "menu-parallel.js"), "fresh");
      writeFileSync(join(pub, "assets", "menu-parallel.js.br"), "fresh");
    });
    expect(existsSync(join(pub, "assets", "menu-parallel.js"))).toBe(true);
    expect(existsSync(join(pub, "assets", "menu-parallel.js.br"))).toBe(true);
    expect(existsSync(join(pub, "assets", "menu-old.js"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("the kept assets are what the bundle gate excludes from this build's total", () => {
    const root = scratch();
    const pub = join(root, "public");
    const now = Date.now();
    publishBundle(generation(root, "morning"), pub, now - 6 * HOUR);
    ageAll(pub, 6 * HOUR);
    publishBundle(generation(root, "evening"), pub, now);

    const kept = retainedAssets(pub, now);
    expect([...kept].filter((f) => f.includes("morning")).sort()).toEqual([
      "index-morning.css",
      "index-morning.js",
      "menu-morning.js",
      "menu-morning.js.br",
    ]);
    rmSync(root, { recursive: true, force: true });
  });
});
