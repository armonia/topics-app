import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @covers BROWSER-DOM-RECORDER-01 */

const ROOT = join(import.meta.dir, "..", "..");

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
