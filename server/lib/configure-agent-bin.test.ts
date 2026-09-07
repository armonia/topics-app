/**
 * @covers RUNTIME-08 @covers CLIADD-02
 *
 * A path typed by hand is the "explicit choice" of RUNTIME-08, and it earns the
 * same treatment as the environment variable: it wins over every probe, and it
 * is believed ONLY if it points at something that exists and can be run. The
 * difference is when the refusal happens. A stale variable is discovered at
 * spawn time, in silence; a path typed in Settings is refused while the person
 * who typed it is still looking at the screen, so the check has to happen here
 * and it has to answer in a sentence they can act on.
 */
import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveTypedBinPath } from "./configure-agent-bin";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agent-bin-"));
}

function fakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

test("an executable file is accepted as it is", () => {
  const path = fakeBinary(scratch(), "codex");
  expect(resolveTypedBinPath("codex", path)).toEqual({ ok: true, path });
});

test("a relative path is refused, because it would resolve elsewhere", () => {
  // Against the server's working directory, which is not the directory the
  // person had in mind.
  const res = resolveTypedBinPath("codex", "bin/codex");
  expect(res.ok).toBe(false);
  expect(res.error).toContain("full path");
});

test("a path pointing at nothing is refused, not stored", () => {
  const res = resolveTypedBinPath("codex", join(scratch(), "codex"));
  expect(res.ok).toBe(false);
});

test("a file without the execute bit is refused", () => {
  const dir = scratch();
  const path = join(dir, "codex");
  writeFileSync(path, "not runnable");
  chmodSync(path, 0o644);
  expect(resolveTypedBinPath("codex", path).ok).toBe(false);
});

test("a directory is searched instead of being refused", () => {
  // What a file picker hands back is a folder far more often than a binary.
  const dir = scratch();
  const path = fakeBinary(dir, "codex");
  expect(resolveTypedBinPath("codex", dir)).toEqual({ ok: true, path });
});

test("an app bundle is searched where the CLI actually lives", () => {
  const dir = scratch();
  const path = fakeBinary(join(dir, "Contents/Resources"), "codex");
  expect(resolveTypedBinPath("codex", dir)).toEqual({ ok: true, path });
});

test("the binary name is the CLI's own, not the agent id", () => {
  // `claude-code` installs a binary called `claude`: looking for the id inside a
  // folder would never find it.
  const dir = scratch();
  const path = fakeBinary(dir, "claude");
  expect(resolveTypedBinPath("claude-code", dir)).toEqual({ ok: true, path });
});

test("a folder without the CLI says which name it looked for", () => {
  const res = resolveTypedBinPath("kimi-code", scratch());
  expect(res.ok).toBe(false);
  expect(res.error).toContain("kimi");
});
