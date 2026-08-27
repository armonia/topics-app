/**
 * @covers RUNTIME-08
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveKimiBin, _resetKimiBinCache } from "./kimi-bin";

afterEach(() => {
  delete process.env.KIMI_BIN;
  _resetKimiBinCache();
});

test("KIMI_BIN override wins when it points at a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-bin-"));
  const bin = join(dir, "kimi");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);

  process.env.KIMI_BIN = bin;
  _resetKimiBinCache();
  expect(resolveKimiBin()).toBe(bin);
});

test("a non-existent KIMI_BIN is ignored (falls through to PATH/candidates)", () => {
  process.env.KIMI_BIN = "/definitely/not/here/kimi";
  _resetKimiBinCache();
  // Either resolves elsewhere (PATH/candidates) or null — but NEVER the bogus path.
  expect(resolveKimiBin()).not.toBe("/definitely/not/here/kimi");
});

test("resolved path, when non-null, actually exists on disk", () => {
  _resetKimiBinCache();
  const p = resolveKimiBin();
  if (p !== null) expect(existsSync(p)).toBe(true);
});
