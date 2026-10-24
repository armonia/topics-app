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
import { BIND_LOOPBACK_NOTE, runScriptBindNote } from "../../shared/background-work";
import { topicsAgentSystemPrompt } from "../lib/topics-agent-prompt";
import { COMMAND_TOOLS, RUN_COMMAND_BOARD_DESCRIPTION, callRunCommand } from "./command-tools";
import { toolsForProfile } from "./topics-mcp-server";

describe("every way of starting a server asks for one on the loopback", () => {
  test("the note names the flag with its address, npm's `--`, and warns off 0.0.0.0", () => {
    expect(BIND_LOOPBACK_NOTE).toContain("`--host 127.0.0.1`");
    expect(BIND_LOOPBACK_NOTE).toContain("`npm run dev -- --host 127.0.0.1`");
    expect(BIND_LOOPBACK_NOTE).toContain("not 0.0.0.0");
  });

  // run_script takes only the script's name: a `"dev": "vite --host"` cannot
  // be told to bind the loopback through it, so it says where to go instead.
  test("run_script sends a script that opens every interface to run_command, or to a shell command where there is none", () => {
    const runScript = (platform: NodeJS.Platform) => toolsForProfile(undefined, platform).find((t) => t.name === "run_script")!.description;
    expect(runScript("darwin")).toContain(runScriptBindNote("with run_command"));
    expect(runScript("win32")).toContain(runScriptBindNote("as a shell command"));
    expect(runScript("win32")).not.toContain("run_command");
    expect(topicsAgentSystemPrompt("auto", "darwin")).toContain(runScriptBindNote("with `mcp__topics__run_command`"));
    expect(topicsAgentSystemPrompt("auto", "win32")).toContain(runScriptBindNote("as a shell command"));
  });

  test("run_command in a chat and on a card, run_script, and the prompt that covers the CLI's background shell", () => {
    const runScript = toolsForProfile(undefined, "darwin").find((t) => t.name === "run_script")!.description;
    const texts = [
      toolsForProfile(undefined, "win32").find((t) => t.name === "run_script")!.description,
      COMMAND_TOOLS[0]!.description,
      RUN_COMMAND_BOARD_DESCRIPTION,
      runScript,
      topicsAgentSystemPrompt("auto", "darwin"),
      topicsAgentSystemPrompt("auto", "win32"),
    ];
    for (const text of texts) expect(text).toContain(BIND_LOOPBACK_NOTE);
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
