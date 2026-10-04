/**
 * The hook script the server writes at boot, next to the token.
 *
 * @covers CCS-06
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookScriptPath, writeHookScript } from "./topics-hook-script";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "hook-script-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the hook script under TOPICS_HOME", () => {
  test("sits next to the token, in claude-hooks/", () => {
    expect(hookScriptPath(home)).toBe(join(home, "claude-hooks", "post-hook.sh"));
  });

  test("first write: the embedded text of scripts/claude-hooks/post-hook.sh, mode 0755", () => {
    const path = hookScriptPath(home);
    expect(writeHookScript(path)).toBe(true);
    const source = readFileSync(join(import.meta.dir, "../../scripts/claude-hooks/post-hook.sh"), "utf-8");
    expect(readFileSync(path, "utf-8")).toBe(source);
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test("rewritten only when different: same text and mode is no write", () => {
    const path = hookScriptPath(home);
    writeHookScript(path);
    expect(writeHookScript(path)).toBe(false);
  });

  test("an outdated text or a lost exec bit is repaired", () => {
    const path = hookScriptPath(home);
    writeHookScript(path);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    expect(writeHookScript(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("/api/claude-hooks/");

    chmodSync(path, 0o644);
    expect(writeHookScript(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  test("a rewrite replaces the file, it never truncates the one live sessions are running", () => {
    const path = hookScriptPath(home);
    writeHookScript(path, "#!/bin/sh\necho old\n");
    // A second name on the same inode: what a hook already running holds open.
    const running = join(home, "running.sh");
    linkSync(path, running);

    writeHookScript(path);
    expect(readFileSync(running, "utf-8")).toBe("#!/bin/sh\necho old\n");
    expect(readFileSync(path, "utf-8")).toContain("/api/claude-hooks/");
    // No temp left next to it.
    expect(readdirSync(join(home, "claude-hooks")).sort()).toEqual(["post-hook.sh"]);
  });
});
