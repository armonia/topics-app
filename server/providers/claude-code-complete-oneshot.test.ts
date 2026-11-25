/**
 * @covers CCLI-10
 *
 * Characterization of the one-shot `complete()` path against a fake CLI: the
 * prompt it writes to stdin, the argv it spawns, the answer on a non-zero exit,
 * the timeout, and the removal of the empty MCP config it pins. Written before
 * the path moved out of `claude-code.ts`, so the move is proven by this file
 * staying unchanged and green.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code";

let dir = "";
const previousCli = process.env.TOPICS_CLAUDE_CLI_PATH;

function fakeCli(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "oneshot-")); });
afterAll(() => {
  if (previousCli === undefined) delete process.env.TOPICS_CLAUDE_CLI_PATH;
  else process.env.TOPICS_CLAUDE_CLI_PATH = previousCli;
  rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeCodeProvider.complete() one-shot", () => {
  test("joins the messages into one prompt on stdin and returns the result text", async () => {
    process.env.TOPICS_CLAUDE_CLI_PATH = fakeCli("echo.ts", `
      const stdin = await new Response(Bun.stdin.stream()).text();
      console.log(JSON.stringify({ type: "result", result: JSON.stringify({ argv: process.argv.slice(2), stdin }) }));
    `);
    const provider = new ClaudeCodeProvider({ type: "claude-code", model: "m-test", defaultWorkspace: dir });
    const out = await provider.complete([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
    const seen = JSON.parse(out.content) as { argv: string[]; stdin: string };
    expect(seen.stdin).toBe("[System]\nbe brief\n\nhello\n\n[Assistant]\nhi\n\nagain");
    const mcpAt = seen.argv.indexOf("--mcp-config");
    expect(mcpAt).toBeGreaterThan(-1);
    const mcpPath = seen.argv[mcpAt + 1]!;
    expect(mcpPath).toContain("oneshot-");
    // The pinned empty config is gone once the CLI has exited.
    expect(existsSync(mcpPath)).toBe(false);
  }, 30_000);

  test("a non-zero exit answers with the exit notice and an error", async () => {
    process.env.TOPICS_CLAUDE_CLI_PATH = fakeCli("fail.ts", `process.exit(3);`);
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: dir });
    const out = await provider.complete([{ role: "user", content: "x" }]);
    expect(out).toEqual({ content: "Error: CLI exited with code 3", error: "exit 3" });
  }, 30_000);

  test("a CLI that never answers is killed at the caller's timeout", async () => {
    process.env.TOPICS_CLAUDE_CLI_PATH = fakeCli("hang.ts", `await Bun.sleep(60_000);`);
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: dir });
    await expect(provider.complete([{ role: "user", content: "x" }], { timeoutMs: 300 }))
      .rejects.toThrow("Completion timed out");
  }, 30_000);
});
