/**
 * Catch blocks that used to swallow a real error (card 7d10a536). The store
 * case throws for real; the others are pinned at the source: the named catch
 * must carry a visible report, so putting `catch {}` back turns this red.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteStorageState } from "./browser-state-store";

const ROOT = mkdtempSync(join(tmpdir(), "silent-catch-sites-"));
const PREVIOUS_DATA_DIR = process.env.DATA_DIR;
beforeAll(() => { process.env.DATA_DIR = join(ROOT, "data"); });
afterAll(() => {
  if (PREVIOUS_DATA_DIR === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = PREVIOUS_DATA_DIR;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("deleteStorageState", () => {
  test("a storage.json that cannot be unlinked is reported and thrown", async () => {
    const { resolveStateDir } = await import("./lib/data-dir");
    const dir = join(resolveStateDir(process.cwd()), "browser-state", "undeletable");
    // A non-empty directory where the file should be: existsSync is true, unlink throws.
    mkdirSync(join(dir, "storage.json"), { recursive: true });
    writeFileSync(join(dir, "storage.json", "x"), "x");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(deleteStorageState("undeletable")).rejects.toBeDefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

function src(file: string): string {
  return readFileSync(join(import.meta.dir, "..", file), "utf8");
}

/** The text of the catch block that follows the first occurrence of `anchor`. */
function catchAfter(file: string, anchor: string, nth = 0): string {
  const text = src(file);
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(anchor, at + 1);
  expect(at).toBeGreaterThan(-1);
  const c = text.indexOf("catch", at);
  return text.slice(c, c + 260);
}

const REPORTS = /console\.(error|warn)\(|warnThrottled\(/;

describe("the catch no longer swallows", () => {
  const sites: [string, string, string, number?][] = [
    ["db schema_migrations backfill", "server/db.ts", "Backfilled schema_migrations"],
    ["end-of-turn tool close UPDATE", "server/utils.ts", "UPDATE messages SET tool_calls = ?, blocks = ? WHERE id = ?`).run(tcStr, blStr, stream.messageId)"],
    ["turn media attach", "server/routes/chat.ts", "updateLastMessageWithMedia(sessionKey, propri, ownRow)"],
    ["stdout drain", "server/routes/processes.ts", "proc.stdout!.getReader()"],
    ["stderr drain", "server/routes/processes.ts", "proc.stderr as ReadableStream<Uint8Array>).getReader()"],
    ["bridge handler", "server/routes/terminal.ts", "handleBridgeMessage(parsed)"],
    ["exited session row", "server/routes/terminal.ts", "DELETE FROM terminal_sessions WHERE id = ?\", [msg.id]"],
    ["cascade kill", "server/routes/terminal.ts", "sendTerminalKill(child.id, 'subagent-cascade', caller)"],
    ["stop marker", "server/lib/command-process-groups.ts", "writeFileSync(commandProcessGroupStopPath(processId)"],
    ["legacy hooks rm", "scripts/install-claude-hooks.ts", "rmSync(LEGACY_HOOKS_DIR"],
  ];
  for (const [name, file, anchor] of sites) {
    test(name, () => {
      expect(catchAfter(file, anchor)).toMatch(REPORTS);
    });
  }

  test("the bridge line parse is separate from the handler", () => {
    const text = src("server/routes/terminal.ts");
    expect(text).not.toContain("handleBridgeMessage(JSON.parse(line))");
  });

  test("the hooks uninstaller does not claim a removal that failed", () => {
    expect(src("scripts/install-claude-hooks.ts")).toContain("if (legacyRemoved)");
  });
});
