/**
 * A stdio MCP server that refuses the handshake (or `tools/list`) used to
 * leave its child process running: `connectMcpServer` threw before anyone
 * held a reference to kill it, and `mountOne`'s `conn` lived inside the
 * `try` block, out of the `catch`'s reach. Both now close the child before
 * rethrowing / recording the failure.
 *
 * @covers MCPSRV-07
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connectMcpServer } from "./mcp-client";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/**
 * A stdio server that writes its own pid to `pidFile` and then answers every
 * JSON-RPC request with an error, without ever exiting by itself: the only
 * way its process stops is someone killing it.
 */
function badHandshakeScript(pidFile: string): string {
  return [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "let buf = '';",
    "process.stdin.setEncoding('utf-8');",
    "process.stdin.on('data', (c) => {",
    "  buf += c; let nl;",
    "  while ((nl = buf.indexOf('\\n')) !== -1) {",
    "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
    "    if (!line.trim()) continue;",
    "    const m = JSON.parse(line);",
    "    if (m.id === undefined) continue;",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: 'nope' } }) + '\\n');",
    "  }",
    "});",
  ].join("\n");
}

async function waitForPid(pidFile: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try { return Number(readFileSync(pidFile, "utf-8")); } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the fake server never wrote its pid");
}

describe("connectMcpServer non lascia orfano un figlio stdio", () => {
  test("handshake rifiutato: il processo figlio muore con la connessione", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-orphan-"));
    const script = join(dir, "bad-handshake.mjs");
    const pidFile = join(dir, "pid.txt");
    writeFileSync(script, badHandshakeScript(pidFile));

    await expect(
      connectMcpServer("bad", { type: "stdio", command: process.execPath, args: ["run", script] }),
    ).rejects.toThrow();

    const pid = await waitForPid(pidFile);
    await new Promise((r) => setTimeout(r, 50)); // the kill signal needs a moment to land
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
