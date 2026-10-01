/**
 * `run_command`'s `description`: the short name the agent gives a command,
 * which the chat's background line, the Processes panel and the wake show
 * instead of the command line (BGVIS-07). The rest of the tool is covered in
 * `topics-mcp-server.test.ts`.
 *
 * @covers BGVIS-07
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TOOLS, callRunCommand } from "./command-tools";

describe("run_command's description", () => {
  test("travels to the route when given, and is left out when blank", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ processId: "p", pid: 1, wake: true }), { status: 200 });
    }) as typeof fetch;
    await callRunCommand({ baseUrl: "http://x", sessionKey: "s" }, { command: "sleep 600", description: "wait for the batch" }, fetchImpl);
    await callRunCommand({ baseUrl: "http://x", sessionKey: "s" }, { command: "sleep 600", description: "  " }, fetchImpl);
    expect(bodies).toEqual([{ command: "sleep 600", description: "wait for the batch" }, { command: "sleep 600" }]);
  });

  test("is an optional property of the tool's schema", () => {
    const schema = COMMAND_TOOLS.find((t) => t.name === "run_command")!.inputSchema;
    expect(Object.keys(schema.properties)).toContain("description");
    expect(schema.required).toEqual(["command"]);
  });
});
