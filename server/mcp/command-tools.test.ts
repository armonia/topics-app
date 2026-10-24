/**
 * `run_command`'s `description`: the short name the agent gives a command,
 * which the chat's background line, the Processes panel and the wake show
 * instead of the command line (BGVIS-07). The rest of the tool is covered in
 * `topics-mcp-server.test.ts`.
 *
 * The tool also asks for a server bound to the loopback (BGVIS-08): the
 * finance chat's server listened on 0.0.0.0:8777 on 24/10.
 *
 * @covers BGVIS-07
 * @covers BGVIS-08
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TOOLS, RUN_COMMAND_BOARD_DESCRIPTION, callRunCommand } from "./command-tools";

describe("run_command asks for a server on the loopback", () => {
  test("in a chat's description and in a board card's", () => {
    for (const text of [COMMAND_TOOLS[0]!.description, RUN_COMMAND_BOARD_DESCRIPTION]) {
      expect(text).toContain("bind a server to 127.0.0.1");
      expect(text).toContain("not 0.0.0.0");
    }
  });
});

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
