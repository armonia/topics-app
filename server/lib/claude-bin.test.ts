/**
 * @covers RUNTIME-08
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveClaudeBin, _resetClaudeBinCache } from "./claude-bin";

afterEach(() => {
  delete process.env.CLAUDE_BIN;
  _resetClaudeBinCache();
});

test("CLAUDE_BIN override wins when it points at a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-bin-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);

  process.env.CLAUDE_BIN = bin;
  _resetClaudeBinCache();
  expect(resolveClaudeBin()).toBe(bin);
});

test("a non-existent CLAUDE_BIN is ignored (falls through to PATH/candidates)", () => {
  process.env.CLAUDE_BIN = "/definitely/not/here/claude";
  _resetClaudeBinCache();
  // Either resolves elsewhere (PATH/candidates) or null — but NEVER the bogus path.
  expect(resolveClaudeBin()).not.toBe("/definitely/not/here/claude");
});

test("resolved path, when non-null, actually exists on disk", () => {
  _resetClaudeBinCache();
  const p = resolveClaudeBin();
  if (p !== null) expect(existsSync(p)).toBe(true);
});
