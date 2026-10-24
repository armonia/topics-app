import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
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

// A compiled binary only carries the files the bundler saw, so the recorder must
// be an import the bundler follows, not a runtime readFileSync from import.meta.dir.
test("a bundled server ships the recorder file as an asset", async () => {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "rrweb-recorder.ts")], target: "bun" });
  expect(r.success).toBe(true);

  const recorderSize = statSync(join(ROOT, "server", "assets", "rrweb.min.js")).size;
  const assets = r.outputs.filter((artifact) => artifact.kind === "asset");
  expect(assets.map((artifact) => artifact.size)).toContain(recorderSize);
});
