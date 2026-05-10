/**
 * deriveToolDetail — unit tests.
 *
 * Validates the provider-boundary normalizer that translates raw tool
 * names + args into the typed ToolCallDetail union the renderer
 * branches on. Pure function; trivial to test exhaustively.
 */

import { describe, expect, test } from "bun:test";
import { deriveToolDetail, deriveToolDetailFromCall } from "./tool-detail";

describe("deriveToolDetail", () => {
  test("shell aliases all collapse to type=shell", () => {
    for (const name of ["Bash", "bash", "shell", "SHELL", "exec_command", "run_command", "Terminal"]) {
      const d = deriveToolDetail(name, { command: "ls" });
      expect(d.type).toBe("shell");
      if (d.type === "shell") expect(d.command).toBe("ls");
    }
  });

  test("shell — picks command from cmd/input fallback", () => {
    expect((deriveToolDetail("Bash", { cmd: "pwd" }) as any).command).toBe("pwd");
    expect((deriveToolDetail("Bash", { input: "echo hi" }) as any).command).toBe("echo hi");
  });

  test("shell — captures cwd + output when provided", () => {
    const d = deriveToolDetail("Bash", { command: "ls", cwd: "/tmp" }, "file1\nfile2");
    expect(d.type).toBe("shell");
    if (d.type === "shell") {
      expect(d.cwd).toBe("/tmp");
      expect(d.output).toBe("file1\nfile2");
    }
  });

  test("read variants → type=read with filePath", () => {
    for (const name of ["Read", "read", "read_file", "view_file", "view"]) {
      const d = deriveToolDetail(name, { file_path: "/foo.ts" });
      expect(d.type).toBe("read");
      if (d.type === "read") expect(d.filePath).toBe("/foo.ts");
    }
  });

  test("read — filePath fallbacks (file_path | filePath | path)", () => {
    expect((deriveToolDetail("Read", { filePath: "a.ts" }) as any).filePath).toBe("a.ts");
    expect((deriveToolDetail("Read", { path: "b.ts" }) as any).filePath).toBe("b.ts");
  });

  test("read — captures offset/limit when present", () => {
    const d = deriveToolDetail("Read", { file_path: "f.ts", offset: 10, limit: 50 }, "...");
    if (d.type === "read") {
      expect(d.offset).toBe(10);
      expect(d.limit).toBe(50);
      expect(d.content).toBe("...");
    }
  });

  test("edit variants → type=edit", () => {
    for (const name of ["Edit", "edit", "apply_patch", "apply_diff", "str_replace_editor", "str_replace"]) {
      const d = deriveToolDetail(name, { file_path: "f.ts", old_string: "a", new_string: "b" });
      expect(d.type).toBe("edit");
      if (d.type === "edit") {
        expect(d.filePath).toBe("f.ts");
        expect(d.oldString).toBe("a");
        expect(d.newString).toBe("b");
      }
    }
  });

  test("MultiEdit → type=edit with first edit + tail marker", () => {
    const d = deriveToolDetail("MultiEdit", {
      file_path: "f.ts",
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "p", new_string: "q" },
        { old_string: "m", new_string: "n" },
      ],
    });
    expect(d.type).toBe("edit");
    if (d.type === "edit") {
      expect(d.oldString).toContain("x");
      expect(d.oldString).toContain("2 more edit");
      expect(d.newString).toContain("y");
    }
  });

  test("write variants → type=write", () => {
    for (const name of ["Write", "write", "write_file", "create_file"]) {
      const d = deriveToolDetail(name, { file_path: "new.ts", content: "// hi" });
      expect(d.type).toBe("write");
      if (d.type === "write") {
        expect(d.filePath).toBe("new.ts");
        expect(d.content).toBe("// hi");
      }
    }
  });

  test("grep → type=search with toolName=grep + mode normalization", () => {
    const d = deriveToolDetail("Grep", { pattern: "TODO", output_mode: "files_with_matches" });
    expect(d.type).toBe("search");
    if (d.type === "search") {
      expect(d.toolName).toBe("grep");
      expect(d.query).toBe("TODO");
      expect(d.mode).toBe("files_with_matches");
    }
  });

  test("glob → type=search with toolName=glob", () => {
    const d = deriveToolDetail("Glob", { pattern: "**/*.ts" });
    if (d.type === "search") {
      expect(d.toolName).toBe("glob");
      expect(d.query).toBe("**/*.ts");
    }
  });

  test("websearch → type=search with toolName=web_search", () => {
    const d = deriveToolDetail("WebSearch", { query: "latest react news" });
    if (d.type === "search") {
      expect(d.toolName).toBe("web_search");
      expect(d.query).toBe("latest react news");
    }
  });

  test("WebFetch → type=fetch with url + prompt + result", () => {
    const d = deriveToolDetail("WebFetch", { url: "https://x.com", prompt: "summarize" }, "result body");
    expect(d.type).toBe("fetch");
    if (d.type === "fetch") {
      expect(d.url).toBe("https://x.com");
      expect(d.prompt).toBe("summarize");
      expect(d.result).toBe("result body");
    }
  });

  test("TodoWrite → type=todo with status mapped per item", () => {
    const d = deriveToolDetail("TodoWrite", {
      todos: [
        { content: "do A", status: "pending", activeForm: "Doing A" },
        { content: "do B", status: "in_progress" },
        { content: "do C", status: "completed" },
      ],
    });
    expect(d.type).toBe("todo");
    if (d.type === "todo") {
      expect(d.items.length).toBe(3);
      expect(d.items[0].status).toBe("pending");
      expect(d.items[0].activeForm).toBe("Doing A");
      expect(d.items[1].status).toBe("in_progress");
      expect(d.items[2].status).toBe("completed");
    }
  });

  test("ExitPlanMode → type=plan", () => {
    const d = deriveToolDetail("ExitPlanMode", { plan: "## Plan\n1. step 1\n2. step 2" });
    expect(d.type).toBe("plan");
    if (d.type === "plan") expect(d.text).toContain("step 1");
  });

  test("Task → type=sub_agent with subAgentType + description", () => {
    const d = deriveToolDetail("Task", {
      subagent_type: "Explore",
      description: "find auth code",
      prompt: "...",
    });
    expect(d.type).toBe("sub_agent");
    if (d.type === "sub_agent") {
      expect(d.subAgentType).toBe("Explore");
      expect(d.description).toBe("find auth code");
      expect(d.actions).toEqual([]);
    }
  });

  test("MCP tool name → type=mcp with namespace stripping", () => {
    const d = deriveToolDetail("mcp__omega-memory__omega_query", { query: "auth" }, "result");
    expect(d.type).toBe("mcp");
    if (d.type === "mcp") {
      expect(d.server).toBe("omega-memory");
      expect(d.tool).toBe("omega_query");
      expect(d.args?.query).toBe("auth");
      expect(d.result).toBe("result");
    }
  });

  test("MCP — tool name with multiple __ joins remainder", () => {
    const d = deriveToolDetail("mcp__server__nested__tool", {});
    if (d.type === "mcp") {
      expect(d.server).toBe("server");
      expect(d.tool).toBe("nested__tool");
    }
  });

  test("unknown tool name → type=unknown with raw args/result", () => {
    const d = deriveToolDetail("CompletelyMadeUpTool", { foo: "bar" }, "ret");
    expect(d.type).toBe("unknown");
    if (d.type === "unknown") {
      expect(d.raw.args?.foo).toBe("bar");
      expect(d.raw.result).toBe("ret");
    }
  });

  test("undefined args → safe defaults", () => {
    const d = deriveToolDetail("Bash", undefined);
    if (d.type === "shell") expect(d.command).toBe("");
  });

  test("null args → no crash", () => {
    const d = deriveToolDetail("Read", null as any);
    if (d.type === "read") expect(d.filePath).toBe("");
  });

  test("array args → coerced to empty record", () => {
    // The function should treat non-record args as missing, not crash.
    const d = deriveToolDetail("Read", [1, 2, 3] as any);
    if (d.type === "read") expect(d.filePath).toBe("");
  });

  test("deriveToolDetailFromCall — convenience wrapper", () => {
    const d = deriveToolDetailFromCall({
      id: "x",
      name: "Bash",
      args: { command: "echo hi" },
      result: "hi",
      status: "success",
    });
    if (d.type === "shell") {
      expect(d.command).toBe("echo hi");
      expect(d.output).toBe("hi");
    }
  });

  test("case-insensitive name matching", () => {
    expect(deriveToolDetail("BASH", { command: "x" }).type).toBe("shell");
    expect(deriveToolDetail("Read", { file_path: "x" }).type).toBe("read");
    expect(deriveToolDetail("EDIT", { file_path: "x" }).type).toBe("edit");
  });
});
