/**
 * @covers MUSE-01
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveMuseBin, _resetMuseBinCache } from "./muse-bin";

afterEach(() => {
  delete process.env.MUSE_BIN;
  _resetMuseBinCache();
});

test("MUSE_BIN override wins when it points at a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-bin-"));
  const bin = join(dir, "muse");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);

  process.env.MUSE_BIN = bin;
  _resetMuseBinCache();
  expect(resolveMuseBin()).toBe(bin);
});

test("a non-existent MUSE_BIN is ignored (falls through to PATH/candidates)", () => {
  process.env.MUSE_BIN = "/definitely/not/here/muse";
  _resetMuseBinCache();
  // Either resolves elsewhere (PATH/candidates) or null — but NEVER the bogus path.
  expect(resolveMuseBin()).not.toBe("/definitely/not/here/muse");
});

test("resolved path, when non-null, actually exists on disk", () => {
  _resetMuseBinCache();
  const p = resolveMuseBin();
  if (p !== null) expect(existsSync(p)).toBe(true);
});
