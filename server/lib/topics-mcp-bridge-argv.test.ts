import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { TOPICS_MCP_BRIDGE_FLAG, topicsMcpBridgeLaunch } from "./topics-mcp-bridge-argv";

const flags = ["--base-url=http://127.0.0.1:3333", "--session-key=topic:x", "--profile=dispatch"];

describe("topicsMcpBridgeLaunch", () => {
  test("checkout: the script is on disk, Bun runs it", () => {
    const got = topicsMcpBridgeLaunch(flags, { moduleDir: "/repo/server/lib", execPath: "/bin/bun", exists: () => true });
    expect(got).toEqual({ command: "/bin/bun", args: ["run", resolve("/repo/server/lib", "../mcp/topics-mcp-server.ts"), ...flags] });
  });

  test("compiled binary: no script on disk, the binary is asked to be the bridge", () => {
    // What Topics 2.3.30 for Windows saw: the embedded path does not exist.
    const exe = "C:\\Users\\u\\AppData\\Local\\Topics\\topics-server.exe";
    const got = topicsMcpBridgeLaunch(flags, { moduleDir: "B:/~BUN/root", execPath: exe, exists: () => false });
    expect(got.command).toBe(exe);
    expect(got.args).toEqual([TOPICS_MCP_BRIDGE_FLAG, ...flags]);
    expect(got.args).not.toContain("run");
  });

  test("the real module dir in this checkout picks the script", () => {
    const got = topicsMcpBridgeLaunch(flags);
    expect(got.args[0]).toBe("run");
    expect(got.args[1]).toEndWith("topics-mcp-server.ts");
  });
});
