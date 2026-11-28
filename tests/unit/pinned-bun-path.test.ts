/**
 * @covers REVIEW-BUN-01
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedBunPath } from "../../server/lib/pinned-bun-path";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pinned-bun-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(version: string | null, withBinary: boolean) {
  const repo = tmp();
  const root = tmp();
  if (version !== null) writeFileSync(join(repo, ".bun-version"), `${version}\n`);
  if (withBinary) {
    mkdirSync(join(root, "9.9.9"));
    writeFileSync(join(root, "9.9.9", "bun"), "#!/bin/sh\necho fake\n");
    chmodSync(join(root, "9.9.9", "bun"), 0o755);
  }
  return { repo, root };
}

test("the child sees the pinned binary as `bun`", async () => {
  const { repo, root } = fixture("9.9.9", true);
  const r = pinnedBunPath(repo, process.env.PATH, root);
  const p = Bun.spawn(["/bin/sh", "-c", "command -v bun"], { env: { ...process.env, PATH: r.path! }, stdout: "pipe" });
  expect((await new Response(p.stdout).text()).trim()).toBe(join(root, "9.9.9", "bun"));
});

test("without .bun-version the PATH is left alone", () => {
  const { repo, root } = fixture(null, true);
  expect(pinnedBunPath(repo, "/usr/bin", root)).toEqual({});
});

test("pinned but not installed: no change, one note", () => {
  const { repo, root } = fixture("9.9.9", false);
  const r = pinnedBunPath(repo, "/usr/bin", root);
  expect(r.path).toBeUndefined();
  expect(r.note).toContain("9.9.9");
});
