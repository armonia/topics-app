import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertRrwebVersionsMatch, getRrwebRecorderSource, readLockedRrwebVersion } from "./rrweb-recorder";

/** @covers BROWSER-DOM-RECORDER-01 */

const ROOT = join(import.meta.dir, "..", "..");

test("the shared recorder matches the installed rrweb package and lockfile", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "client", "package.json"), "utf8")) as {
    dependencies: { rrweb: string };
  };
  const lockedVersion = readLockedRrwebVersion(readFileSync(join(ROOT, "client", "bun.lock"), "utf8"));
  const installedRecorder = readFileSync(join(ROOT, "client", "node_modules", "rrweb", "dist", "rrweb.min.js"), "utf8")
    .replace(/\n\/\/# sourceMappingURL=.*$/m, "");
  const browserService = readFileSync(join(ROOT, "server", "browser-service.ts"), "utf8");
  const browserRoute = readFileSync(join(ROOT, "server", "routes", "browser.ts"), "utf8");

  assertRrwebVersionsMatch(manifest.dependencies.rrweb, lockedVersion);
  expect(browserService).toContain("getRrwebRecorderSource()");
  expect(browserRoute).toContain("getRrwebRecorderSource()");
  expect(getRrwebRecorderSource()).toBe(installedRecorder);
  expect(getRrwebRecorderSource()).toBe(getRrwebRecorderSource());
});

// A compiled binary only carries what the bundler saw, so the recorder must be an
// import the bundler follows (not a readFileSync from import.meta.dir), and it
// must be INLINED: a second output file would break `bun build --outfile=/dev/null`
// (the reload gate), which only accepts a single-output bundle.
test("a bundled server inlines the recorder text in a single output", async () => {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "rrweb-recorder.ts")], target: "bun" });
  expect(r.success).toBe(true);
  expect(r.outputs).toHaveLength(1);

  // Distinctive tokens of the vendored file that rrweb-recorder.ts itself never
  // mentions: they only reach the bundle if the text is inlined, not referenced
  // by path. The bundler re-quotes string literals, so no quotes in the needles.
  const recorder = readFileSync(join(ROOT, "server", "assets", "rrweb.min.js"), "utf8");
  const bundled = await r.outputs[0].text();
  for (const token of ["var rrweb=function(", "__rrweb_original__", "mouseInteraction"]) {
    expect(recorder).toContain(token);
    expect(bundled).toContain(token);
  }
});
